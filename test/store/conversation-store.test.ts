import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { getLcmConnection, closeLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import {
  ConversationStore,
  getConversationStoreAtomicCore,
  type AppendMessageInput,
  type ConversationId,
  type CreateMessageInput,
  type CreateMessagePartInput,
  type MessageId,
} from "../../src/store/conversation-store.js";

type ExactParameters<Actual, Expected> =
  Actual extends Expected
    ? Expected extends Actual
      ? true
      : false
    : false;

const publicAtomicParameterContract: [
  ExactParameters<
    Parameters<ConversationStore["createMessagesBulk"]>,
    [inputs: CreateMessageInput[]]
  >,
  ExactParameters<
    Parameters<ConversationStore["appendMessages"]>,
    [conversationId: ConversationId, inputs: AppendMessageInput[]]
  >,
  ExactParameters<
    Parameters<ConversationStore["createMessageParts"]>,
    [messageId: MessageId, parts: CreateMessagePartInput[]]
  >,
  ExactParameters<
    Parameters<ConversationStore["deleteMessages"]>,
    [messageIds: MessageId[]]
  >,
] = [true, true, true, true];

const tempDirs: string[] = [];

function nestedQuantifierFixture(): string {
  return String.fromCharCode(40, 97, 43, 41, 43, 36);
}

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDb(): DatabaseSync {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-conv-store-test-"));
  tempDirs.push(tempDir);
  const db = getLcmConnection(join(tempDir, "test.db"));
  runLcmMigrations(db);
  return db;
}

function makeStore(db: DatabaseSync): ConversationStore {
  return new ConversationStore(db, { fts5Available: false });
}

function trackedDatabase(db: DatabaseSync): {
  database: DatabaseSync;
  statements: string[];
  prepared: string[];
} {
  const statements: string[] = [];
  const prepared: string[] = [];
  return {
    database: {
      exec: (sql: string): void => {
        statements.push(sql);
        db.exec(sql);
      },
      prepare: (sql: string) => {
        prepared.push(sql);
        return db.prepare(sql);
      },
    } as unknown as DatabaseSync,
    statements,
    prepared,
  };
}

function normalizedTransactionStatements(statements: readonly string[]): string[] {
  return statements.map((statement) =>
    statement.replace(/lcm_conversation_atomic_[0-9]+/gu, "lcm_conversation_atomic"));
}

// ── Conversation CRUD ─────────────────────────────────────────────────────────

describe("ConversationStore — conversation CRUD", () => {
  it("createConversation returns a record with correct fields", async () => {
    const store = makeStore(makeDb());
    const rec = await store.createConversation({ sessionId: "sess-1", title: "My Session" });
    expect(rec.sessionId).toBe("sess-1");
    expect(rec.title).toBe("My Session");
    expect(rec.conversationId).toBeGreaterThan(0);
    expect(rec.bootstrappedAt).toBeNull();
    expect(rec.createdAt).toBeInstanceOf(Date);
  });

  it("createConversation stores null title when not provided", async () => {
    const store = makeStore(makeDb());
    const rec = await store.createConversation({ sessionId: "sess-notitle" });
    expect(rec.title).toBeNull();
  });

  it("getConversation returns null for unknown id", async () => {
    const store = makeStore(makeDb());
    expect(await store.getConversation(9999)).toBeNull();
  });

  it("getConversationBySessionId returns a conversation for the sessionId when multiple exist", async () => {
    const db = makeDb();
    const store = makeStore(db);
    await store.createConversation({ sessionId: "shared-sess" });
    await store.createConversation({ sessionId: "shared-sess", title: "newer" });
    const result = await store.getConversationBySessionId("shared-sess");
    // Should return one of the conversations for the session (most-recent by created_at)
    expect(result).not.toBeNull();
    expect(result?.sessionId).toBe("shared-sess");
  });

  it("getConversationBySessionId returns null for unknown sessionId", async () => {
    const store = makeStore(makeDb());
    expect(await store.getConversationBySessionId("no-such-session")).toBeNull();
  });

  it("getOrCreateConversation is idempotent for same sessionId", async () => {
    const store = makeStore(makeDb());
    const first = await store.getOrCreateConversation("idem-sess");
    const second = await store.getOrCreateConversation("idem-sess");
    expect(first.conversationId).toBe(second.conversationId);
  });

  it("markConversationBootstrapped sets bootstrappedAt only once (COALESCE)", async () => {
    const store = makeStore(makeDb());
    const conv = await store.createConversation({ sessionId: "boot-sess" });
    await store.markConversationBootstrapped(conv.conversationId);
    const after1 = await store.getConversation(conv.conversationId);
    expect(after1?.bootstrappedAt).toBeInstanceOf(Date);

    await store.markConversationBootstrapped(conv.conversationId);
    const after2 = await store.getConversation(conv.conversationId);
    // bootstrappedAt should remain unchanged (COALESCE prevents overwrite)
    expect(after2?.bootstrappedAt?.getTime()).toBe(after1?.bootstrappedAt?.getTime());
  });

  it("listConversations returns all conversations in order", async () => {
    const store = makeStore(makeDb());
    await store.createConversation({ sessionId: "list-1" });
    await store.createConversation({ sessionId: "list-2" });
    const list = await store.listConversations();
    expect(list.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Message operations ────────────────────────────────────────────────────────

describe("ConversationStore — message operations", () => {
  let store: ConversationStore;
  let conversationId: number;

  beforeEach(async () => {
    store = makeStore(makeDb());
    const conv = await store.createConversation({ sessionId: "msg-sess" });
    conversationId = conv.conversationId;
  });

  it("createMessage returns correct record", async () => {
    const msg = await store.createMessage({
      conversationId,
      seq: 1,
      role: "user",
      content: "hello world",
      tokenCount: 2,
    });
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("hello world");
    expect(msg.tokenCount).toBe(2);
    expect(msg.seq).toBe(1);
  });

  it("getMessages returns messages in seq order", async () => {
    await store.createMessage({ conversationId, seq: 1, role: "user", content: "a", tokenCount: 1 });
    await store.createMessage({ conversationId, seq: 2, role: "assistant", content: "b", tokenCount: 1 });
    const msgs = await store.getMessages(conversationId);
    expect(msgs.map((m) => m.seq)).toEqual([1, 2]);
  });

  it("getMessages with afterSeq filters correctly", async () => {
    await store.createMessage({ conversationId, seq: 1, role: "user", content: "a", tokenCount: 1 });
    await store.createMessage({ conversationId, seq: 2, role: "user", content: "b", tokenCount: 1 });
    await store.createMessage({ conversationId, seq: 3, role: "user", content: "c", tokenCount: 1 });
    const msgs = await store.getMessages(conversationId, { afterSeq: 1 });
    expect(msgs.map((m) => m.seq)).toEqual([2, 3]);
  });

  it("getMessages with limit restricts results", async () => {
    for (let i = 1; i <= 5; i++) {
      await store.createMessage({ conversationId, seq: i, role: "user", content: `msg${i}`, tokenCount: 1 });
    }
    const msgs = await store.getMessages(conversationId, { limit: 3 });
    expect(msgs).toHaveLength(3);
  });

  it("getLastMessage returns null for empty conversation", async () => {
    expect(await store.getLastMessage(conversationId)).toBeNull();
  });

  it("getLastMessage returns the highest-seq message", async () => {
    await store.createMessage({ conversationId, seq: 1, role: "user", content: "first", tokenCount: 1 });
    await store.createMessage({ conversationId, seq: 2, role: "assistant", content: "last", tokenCount: 1 });
    const last = await store.getLastMessage(conversationId);
    expect(last?.seq).toBe(2);
    expect(last?.content).toBe("last");
  });

  it("getMaxSeq returns 0 when no messages exist", async () => {
    expect(await store.getMaxSeq(conversationId)).toBe(0);
  });

  it("getMaxSeq returns the highest seq", async () => {
    await store.createMessage({ conversationId, seq: 5, role: "user", content: "x", tokenCount: 1 });
    await store.createMessage({ conversationId, seq: 3, role: "user", content: "y", tokenCount: 1 });
    expect(await store.getMaxSeq(conversationId)).toBe(5);
  });

  it("hasMessage returns false when message absent", async () => {
    expect(await store.hasMessage(conversationId, "user", "no such message")).toBe(false);
  });

  it("hasMessage returns true when message present", async () => {
    await store.createMessage({ conversationId, seq: 1, role: "user", content: "exact text", tokenCount: 1 });
    expect(await store.hasMessage(conversationId, "user", "exact text")).toBe(true);
  });

  it("countMessagesByIdentity counts exact duplicates", async () => {
    await store.createMessage({ conversationId, seq: 1, role: "user", content: "dup", tokenCount: 1 });
    await store.createMessage({ conversationId, seq: 2, role: "user", content: "dup", tokenCount: 1 });
    expect(await store.countMessagesByIdentity(conversationId, "user", "dup")).toBe(2);
  });

  it("getMessageById returns null for unknown id", async () => {
    expect(await store.getMessageById(99999)).toBeNull();
  });

  it("getMessageCount returns correct count", async () => {
    await store.createMessage({ conversationId, seq: 1, role: "user", content: "x", tokenCount: 1 });
    await store.createMessage({ conversationId, seq: 2, role: "user", content: "y", tokenCount: 1 });
    expect(await store.getMessageCount(conversationId)).toBe(2);
  });

  it("getMessageCountBySessionId counts messages across split conversations", async () => {
    await store.createMessage({ conversationId, seq: 1, role: "user", content: "first", tokenCount: 1 });
    const split = await store.createConversation({ sessionId: "msg-sess" });
    await store.createMessage({ conversationId: split.conversationId, seq: 1, role: "assistant", content: "second", tokenCount: 1 });
    await store.createMessage({ conversationId: split.conversationId, seq: 2, role: "user", content: "third", tokenCount: 1 });
    const unrelated = await store.createConversation({ sessionId: "other-session" });
    await store.createMessage({ conversationId: unrelated.conversationId, seq: 1, role: "user", content: "ignored", tokenCount: 1 });

    expect(await store.getMessageCountBySessionId("msg-sess")).toBe(3);
    expect(await store.getMessageCountBySessionId("missing-session")).toBe(0);
  });

  it("createMessagesBulk inserts all messages and returns records", async () => {
    const records = await store.createMessagesBulk([
      { conversationId, seq: 10, role: "user", content: "bulk1", tokenCount: 1 },
      { conversationId, seq: 11, role: "assistant", content: "bulk2", tokenCount: 1 },
    ]);
    expect(records).toHaveLength(2);
    expect(records[0].content).toBe("bulk1");
    expect(records[1].content).toBe("bulk2");
  });

  it("createMessagesBulk with empty array returns empty array", async () => {
    const records = await store.createMessagesBulk([]);
    expect(records).toEqual([]);
  });

  it("appendMessages allocates contiguous sequence numbers from zero", async () => {
    const initial = await store.appendMessages(conversationId, [
      { role: "user", content: "first", tokenCount: 0 },
      { role: "assistant", content: "second", tokenCount: 2 },
    ]);
    const following = await store.appendMessages(conversationId, [
      { role: "tool", content: "third", tokenCount: 3 },
    ]);

    expect(initial.map((message) => message.seq)).toEqual([0, 1]);
    expect(initial.map((message) => message.tokenCount)).toEqual([0, 2]);
    expect(following.map((message) => message.seq)).toEqual([2]);
    expect((await store.getMessages(conversationId)).map((message) => message.content))
      .toEqual(["first", "second", "third"]);
  });

  it("appendMessages with an empty array is a no-op", async () => {
    await expect(store.appendMessages(conversationId, [])).resolves.toEqual([]);
    await expect(store.getMessages(conversationId)).resolves.toEqual([]);
  });

  it.each([
    ["negative", -1],
    ["fractional", 0.5],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects %s message and part integers before issuing SQL", async (_label, invalid) => {
    const tracked = trackedDatabase(makeDb());
    const localStore = makeStore(tracked.database);
    const conversation = await localStore.createConversation({ sessionId: "invalid-integers" });
    const seed = await localStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 0,
      role: "system",
      content: "seed",
      tokenCount: 0,
    });
    tracked.statements.length = 0;
    tracked.prepared.length = 0;

    await expect(localStore.createMessage({
      conversationId: conversation.conversationId,
      seq: invalid,
      role: "user",
      content: "invalid seq",
      tokenCount: 0,
    })).rejects.toThrow("message seq must be a non-negative safe integer");
    await expect(localStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "user",
      content: "invalid tokens",
      tokenCount: invalid,
    })).rejects.toThrow("message tokenCount must be a non-negative safe integer");
    await expect(localStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "valid prefix",
        tokenCount: 0,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "invalid suffix",
        tokenCount: invalid,
      },
    ])).rejects.toThrow("message tokenCount must be a non-negative safe integer");
    await expect(localStore.appendMessages(conversation.conversationId, [
      { role: "user", content: "valid prefix", tokenCount: 0 },
      { role: "assistant", content: "invalid suffix", tokenCount: invalid },
    ])).rejects.toThrow("message tokenCount must be a non-negative safe integer");
    await expect(localStore.createMessageParts(seed.messageId, [
      { sessionId: "invalid-integers", partType: "text", ordinal: 0 },
      { sessionId: "invalid-integers", partType: "reasoning", ordinal: invalid },
    ])).rejects.toThrow("message part ordinal must be a non-negative safe integer");

    expect(tracked.statements).toEqual([]);
    expect(tracked.prepared).toEqual([]);
    expect((await localStore.getMessages(conversation.conversationId)).map(
      (message) => message.content,
    )).toEqual(["seed"]);
    expect(await localStore.getMessageParts(seed.messageId)).toEqual([]);
  });

  it("round-trips maximum safe message and part integers", async () => {
    const message = await store.createMessage({
      conversationId,
      seq: Number.MAX_SAFE_INTEGER,
      role: "assistant",
      content: "maximum safe",
      tokenCount: Number.MAX_SAFE_INTEGER,
    });
    await store.createMessageParts(message.messageId, [{
      sessionId: "msg-sess",
      partType: "reasoning",
      ordinal: Number.MAX_SAFE_INTEGER,
    }]);

    expect(message).toMatchObject({
      seq: Number.MAX_SAFE_INTEGER,
      tokenCount: Number.MAX_SAFE_INTEGER,
    });
    expect(await store.getMessageParts(message.messageId)).toMatchObject([{
      ordinal: Number.MAX_SAFE_INTEGER,
    }]);
  });

  it("keeps an outer transaction usable after a rejected negative append batch", async () => {
    const tracked = trackedDatabase(makeDb());
    const localStore = makeStore(tracked.database);
    const peer = makeStore(tracked.database);
    const conversation = await localStore.createConversation({
      sessionId: "negative-append-transaction",
    });
    tracked.statements.length = 0;

    await localStore.withTransaction(async () => {
      await expect(peer.appendMessages(conversation.conversationId, [
        { role: "user", content: "partial", tokenCount: 1 },
        { role: "assistant", content: "invalid", tokenCount: -1 },
      ])).rejects.toThrow("message tokenCount must be a non-negative safe integer");
      await expect(peer.appendMessages(conversation.conversationId, [
        { role: "user", content: "zero", tokenCount: 0 },
        { role: "assistant", content: "positive", tokenCount: 2 },
      ])).resolves.toMatchObject([
        { seq: 0, tokenCount: 0 },
        { seq: 1, tokenCount: 2 },
      ]);
    });

    expect((await localStore.getMessages(conversation.conversationId)).map(
      (message) => message.content,
    )).toEqual(["zero", "positive"]);
    expect(normalizedTransactionStatements(tracked.statements)).toEqual([
      "BEGIN IMMEDIATE",
      "SAVEPOINT lcm_conversation_atomic",
      "RELEASE SAVEPOINT lcm_conversation_atomic",
      "COMMIT",
    ]);
  });

});

// ── Message parts ─────────────────────────────────────────────────────────────

describe("ConversationStore — message parts", () => {
  it("createMessageParts and getMessageParts round-trip", async () => {
    const store = makeStore(makeDb());
    const conv = await store.createConversation({ sessionId: "parts-sess" });
    const msg = await store.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "assistant",
      content: "tool output",
      tokenCount: 3,
    });

    await store.createMessageParts(msg.messageId, [
      {
        sessionId: "parts-sess",
        partType: "tool",
        ordinal: 0,
        toolName: "Bash",
        toolInput: '{"command":"ls"}',
        toolOutput: "file1.ts\nfile2.ts",
        toolCallId: "call-abc",
      },
      {
        sessionId: "parts-sess",
        partType: "text",
        ordinal: 1,
        textContent: "done",
      },
    ]);

    const parts = await store.getMessageParts(msg.messageId);
    expect(parts).toHaveLength(2);
    expect(parts[0].partType).toBe("tool");
    expect(parts[0].toolName).toBe("Bash");
    expect(parts[0].ordinal).toBe(0);
    expect(parts[1].partType).toBe("text");
    expect(parts[1].textContent).toBe("done");
    expect(parts[1].toolName).toBeNull();
  });

  it("createMessageParts with empty array is a no-op", async () => {
    const store = makeStore(makeDb());
    const conv = await store.createConversation({ sessionId: "empty-parts-sess" });
    const msg = await store.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "hi",
      tokenCount: 1,
    });
    await store.createMessageParts(msg.messageId, []);
    const parts = await store.getMessageParts(msg.messageId);
    expect(parts).toHaveLength(0);
  });

});

// ── deleteMessages ────────────────────────────────────────────────────────────

describe("ConversationStore — deleteMessages", () => {
  it("returns 0 for empty array", async () => {
    const store = makeStore(makeDb());
    expect(await store.deleteMessages([])).toBe(0);
  });

  it("deletes messages not referenced by summaries", async () => {
    const store = makeStore(makeDb());
    const conv = await store.createConversation({ sessionId: "del-sess" });
    const msg = await store.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "deletable",
      tokenCount: 1,
    });

    const deleted = await store.deleteMessages([msg.messageId]);
    expect(deleted).toBe(1);
    expect(await store.getMessageById(msg.messageId)).toBeNull();
  });

});

// ── searchMessages — regex mode ───────────────────────────────────────────────

describe("ConversationStore — searchMessages regex", () => {
  it("finds messages matching a regex pattern", async () => {
    const store = makeStore(makeDb());
    const conv = await store.createConversation({ sessionId: "search-sess" });
    await store.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "use React hooks",
      tokenCount: 3,
    });
    await store.createMessage({
      conversationId: conv.conversationId,
      seq: 2,
      role: "user",
      content: "prefer Vue",
      tokenCount: 2,
    });

    const results = await store.searchMessages({
      query: "React|Vue",
      mode: "regex",
    });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("throws on unsafe regex pattern", async () => {
    const store = makeStore(makeDb());
    await expect(
      store.searchMessages({ query: nestedQuantifierFixture(), mode: "regex" }),
    ).rejects.toThrow(/unsafe/i);
  });

  it("returns empty when no message matches regex", async () => {
    const store = makeStore(makeDb());
    const conv = await store.createConversation({ sessionId: "nomatch-sess" });
    await store.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "hello world",
      tokenCount: 2,
    });

    const results = await store.searchMessages({ query: "xyz123nomatch", mode: "regex" });
    expect(results).toHaveLength(0);
  });

  it("respects limit in regex search", async () => {
    const store = makeStore(makeDb());
    const conv = await store.createConversation({ sessionId: "limit-sess" });
    for (let i = 1; i <= 5; i++) {
      await store.createMessage({
        conversationId: conv.conversationId,
        seq: i,
        role: "user",
        content: `token-${i}`,
        tokenCount: 1,
      });
    }
    const results = await store.searchMessages({ query: "token-\\d", mode: "regex", limit: 2 });
    expect(results).toHaveLength(2);
  });
});

// ── withTransaction ───────────────────────────────────────────────────────────

describe("ConversationStore — withTransaction", () => {
  it("exposes contract-shaped atomic methods without a public bypass flag", () => {
    const store = makeStore(makeDb());

    expect(publicAtomicParameterContract).toEqual([true, true, true, true]);
    expect([
      store.createMessagesBulk.length,
      store.appendMessages.length,
      store.createMessageParts.length,
      store.deleteMessages.length,
    ]).toEqual([1, 2, 2, 1]);
    expect(Object.keys(getConversationStoreAtomicCore(store)).sort()).toEqual([
      "appendMessages",
      "createMessageParts",
      "createMessagesBulk",
      "deleteMessages",
    ]);
    expect(() => getConversationStoreAtomicCore(
      Object.create(ConversationStore.prototype) as ConversationStore,
    )).toThrow("conversation store atomic core is unavailable");
  });

  it("reuses a live same-handle direct transaction for nested transaction helpers", async () => {
    const tracked = trackedDatabase(makeDb());
    const store = makeStore(tracked.database);

    await expect(store.withTransaction(() =>
      store.withTransaction(() => "same transaction"))).resolves.toBe("same transaction");
    expect(tracked.statements).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  });

  it("commits and returns a successful operation result", async () => {
    const store = makeStore(makeDb());
    const conversation = await store.createConversation({ sessionId: "tx-commit" });
    await expect(store.withTransaction(async () => {
      await store.createMessage({
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "committed write",
        tokenCount: 2,
      });
      return "committed";
    })).resolves.toBe("committed");
    await expect(store.getMessageCount(conversation.conversationId)).resolves.toBe(1);
  });

  it("rolls back on thrown error and re-throws", async () => {
    const store = makeStore(makeDb());
    const conv = await store.createConversation({ sessionId: "tx-sess" });

    await expect(
      store.withTransaction(async () => {
        await store.createMessage({
          conversationId: conv.conversationId,
          seq: 1,
          role: "user",
          content: "aborted",
          tokenCount: 1,
        });
        throw new Error("intentional rollback");
      }),
    ).rejects.toThrow("intentional rollback");

    // Message should not exist after rollback
    expect(await store.getMessageCount(conv.conversationId)).toBe(0);
  });

  it.each(["retry", "already-clean"] as const)(
    "preserves the original failure and releases the queue after one rollback %s",
    async (recovery) => {
      const raw = makeDb();
      const statements: string[] = [];
      let rollbackAttempts = 0;
      const database = {
        exec: (sql: string): void => {
          statements.push(sql);
          if (sql === "ROLLBACK") {
            rollbackAttempts += 1;
            if (rollbackAttempts === 1) {
              if (recovery === "already-clean") raw.exec(sql);
              throw new Error("rollback /private/recovery-secret");
            }
          }
          raw.exec(sql);
        },
        prepare: (sql: string) => raw.prepare(sql),
        get isTransaction(): boolean {
          return raw.isTransaction;
        },
      } as unknown as DatabaseSync;
      const store = makeStore(database);
      const original = new Error(`original-${recovery}`);
      let releaseFirst!: () => void;
      let markFirstEntered!: () => void;
      const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
      const first = store.withTransaction(async () => {
        markFirstEntered();
        await firstRelease;
        throw original;
      }).then(
        () => null,
        (error: unknown) => error,
      );
      await firstEntered;
      const second = store.withTransaction(() => "queue released");
      releaseFirst();

      const observed = await first;
      expect(observed).toBe(original);
      expect(String(observed)).not.toContain("recovery-secret");
      await expect(second).resolves.toBe("queue released");
      expect(statements).toEqual(recovery === "retry"
        ? [
            "BEGIN IMMEDIATE",
            "ROLLBACK",
            "ROLLBACK",
            "BEGIN IMMEDIATE",
            "COMMIT",
          ]
        : [
            "BEGIN IMMEDIATE",
            "ROLLBACK",
            "BEGIN IMMEDIATE",
            "COMMIT",
          ]);
    },
  );

  it("preserves a commit error and fences queued atomic work after persistent rollback failure", async () => {
    const raw = makeDb();
    const statements: string[] = [];
    let prepareCalls = 0;
    const commitError = new Error("original commit failure");
    const database = {
      exec: (sql: string): void => {
        statements.push(sql);
        if (sql === "COMMIT") throw commitError;
        if (sql === "ROLLBACK") {
          throw new Error("rollback /private/persistent-secret");
        }
        raw.exec(sql);
      },
      prepare: (sql: string) => {
        prepareCalls += 1;
        return raw.prepare(sql);
      },
      get isTransaction(): boolean {
        return raw.isTransaction;
      },
    } as unknown as DatabaseSync;
    const store = makeStore(database);
    const peer = makeStore(database);
    const conversation = await store.createConversation({
      sessionId: "persistent-rollback-failure",
    });
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const first = store.withTransaction(async () => {
      markFirstEntered();
      await firstRelease;
      return "commit attempt";
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await firstEntered;
    const queued = expect(store.withTransaction(() => "must not enter"))
      .rejects.toThrow("conversation store transaction state is unavailable");
    releaseFirst();

    const observed = await first;
    expect(observed).toBe(commitError);
    expect(String(observed)).not.toContain("persistent-secret");
    await queued;
    await expect(store.createMessagesBulk([{
      conversationId: conversation.conversationId,
      seq: 0,
      role: "user",
      content: "must stay fenced",
      tokenCount: 1,
    }])).rejects.toThrow("conversation store transaction state is unavailable");
    const prepareCallsBeforePeer = prepareCalls;
    await expect(peer.getConversation(conversation.conversationId))
      .rejects.toThrow("conversation store transaction state is unavailable");
    await expect(peer.createConversation({ sessionId: "must-not-write" }))
      .rejects.toThrow("conversation store transaction state is unavailable");
    expect(prepareCalls).toBe(prepareCallsBeforePeer);
    expect(statements).toEqual([
      "BEGIN IMMEDIATE",
      "COMMIT",
      "ROLLBACK",
      "ROLLBACK",
    ]);
    raw.exec("ROLLBACK");
  });

  it("reuses one same-database transaction for every public atomic batch method", async () => {
    const tracked = trackedDatabase(makeDb());
    const store = makeStore(tracked.database);
    const peer = makeStore(tracked.database);
    const conversation = await store.createConversation({ sessionId: "tx-atomic-commit" });
    const seeded = await store.createMessage({
      conversationId: conversation.conversationId,
      seq: 0,
      role: "system",
      content: "delete me",
      tokenCount: 1,
    });

    await expect(store.withTransaction(async () => {
      const [bulk] = await peer.createMessagesBulk([{
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "bulk",
        tokenCount: 1,
      }]);
      const [appended] = await peer.appendMessages(conversation.conversationId, [{
        role: "assistant",
        content: "append",
        tokenCount: 1,
      }]);
      await peer.createMessageParts(bulk.messageId, [{
        sessionId: "tx-atomic-commit",
        partType: "text",
        ordinal: 0,
        textContent: "part",
      }]);
      await expect(peer.deleteMessages([seeded.messageId])).resolves.toBe(1);
      return [bulk.seq, appended.seq];
    })).resolves.toEqual([1, 2]);

    expect(normalizedTransactionStatements(tracked.statements)).toEqual([
      "BEGIN IMMEDIATE",
      "SAVEPOINT lcm_conversation_atomic",
      "RELEASE SAVEPOINT lcm_conversation_atomic",
      "SAVEPOINT lcm_conversation_atomic",
      "RELEASE SAVEPOINT lcm_conversation_atomic",
      "SAVEPOINT lcm_conversation_atomic",
      "RELEASE SAVEPOINT lcm_conversation_atomic",
      "SAVEPOINT lcm_conversation_atomic",
      "RELEASE SAVEPOINT lcm_conversation_atomic",
      "COMMIT",
    ]);
    expect((await store.getMessages(conversation.conversationId)).map((message) => message.seq))
      .toEqual([1, 2]);
    expect(await store.getMessageParts(
      (await store.getMessages(conversation.conversationId))[0]!.messageId,
    )).toMatchObject([{ textContent: "part" }]);
  });

  it("rolls back every public atomic batch method inside withTransaction", async () => {
    const store = makeStore(makeDb());
    const conversation = await store.createConversation({ sessionId: "tx-atomic-rollback" });
    const seeded = await store.createMessage({
      conversationId: conversation.conversationId,
      seq: 0,
      role: "system",
      content: "keep me",
      tokenCount: 1,
    });

    await expect(store.withTransaction(async () => {
      await store.createMessagesBulk([{
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "bulk",
        tokenCount: 1,
      }]);
      await store.appendMessages(conversation.conversationId, [{
        role: "assistant",
        content: "append",
        tokenCount: 1,
      }]);
      await store.createMessageParts(seeded.messageId, [{
        sessionId: "tx-atomic-rollback",
        partType: "text",
        ordinal: 0,
        textContent: "rolled back",
      }]);
      await store.deleteMessages([seeded.messageId]);
      throw new Error("rollback all atomic methods");
    })).rejects.toThrow("rollback all atomic methods");

    expect((await store.getMessages(conversation.conversationId)).map((message) => message.messageId))
      .toEqual([seeded.messageId]);
    await expect(store.getMessageParts(seeded.messageId)).resolves.toEqual([]);
  });

  it.each([
    "createMessagesBulk",
    "appendMessages",
    "createMessageParts",
    "deleteMessages",
  ] as const)(
    "rolls back a caught partial %s failure while committing unrelated outer work",
    async (operation) => {
      const tracked = trackedDatabase(makeDb());
      const store = makeStore(tracked.database);
      const peer = makeStore(tracked.database);
      const conversation = await store.createConversation({
        sessionId: `caught-${operation}`,
      });
      const seeded = await store.createMessagesBulk([
        {
          conversationId: conversation.conversationId,
          seq: 0,
          role: "system",
          content: "parts target",
          tokenCount: 1,
        },
        {
          conversationId: conversation.conversationId,
          seq: 1,
          role: "user",
          content: "first delete target",
          tokenCount: 1,
        },
        {
          conversationId: conversation.conversationId,
          seq: 2,
          role: "assistant",
          content: "second delete target",
          tokenCount: 1,
        },
      ]);
      if (operation === "deleteMessages") {
        tracked.database.exec(
          `CREATE TRIGGER fail_caught_delete
           BEFORE DELETE ON messages
           WHEN OLD.message_id = ${seeded[2].messageId}
           BEGIN
             SELECT RAISE(ABORT, 'injected delete failure');
           END`,
        );
      }
      tracked.statements.length = 0;
      let caught = false;

      await expect(store.withTransaction(async () => {
        try {
          switch (operation) {
            case "createMessagesBulk":
              await peer.createMessagesBulk([
                {
                  conversationId: conversation.conversationId,
                  seq: 3,
                  role: "user",
                  content: "partial bulk",
                  tokenCount: 1,
                },
                {
                  conversationId: conversation.conversationId,
                  seq: 4,
                  role: "invalid" as "assistant",
                  content: "invalid bulk",
                  tokenCount: 1,
                },
              ]);
              break;
            case "appendMessages":
              await peer.appendMessages(conversation.conversationId, [
                { role: "user", content: "partial append", tokenCount: 1 },
                {
                  role: "invalid" as "assistant",
                  content: "invalid append",
                  tokenCount: 1,
                },
              ]);
              break;
            case "createMessageParts":
              await peer.createMessageParts(seeded[0].messageId, [
                {
                  sessionId: `caught-${operation}`,
                  partType: "text",
                  ordinal: 0,
                  textContent: "partial part",
                },
                {
                  sessionId: `caught-${operation}`,
                  partType: "reasoning",
                  ordinal: 0,
                  textContent: "duplicate part",
                },
              ]);
              break;
            case "deleteMessages":
              await peer.deleteMessages([
                seeded[1].messageId,
                seeded[2].messageId,
              ]);
              break;
          }
        } catch {
          caught = true;
        }
        await peer.createMessage({
          conversationId: conversation.conversationId,
          seq: 10,
          role: "tool",
          content: `sentinel-${operation}`,
          tokenCount: 1,
        });
      })).resolves.toBeUndefined();

      expect(caught).toBe(true);
      expect(normalizedTransactionStatements(tracked.statements)).toEqual([
        "BEGIN IMMEDIATE",
        "SAVEPOINT lcm_conversation_atomic",
        "ROLLBACK TO SAVEPOINT lcm_conversation_atomic",
        "RELEASE SAVEPOINT lcm_conversation_atomic",
        "COMMIT",
      ]);
      const messages = await store.getMessages(conversation.conversationId);
      expect(messages.map((message) => message.messageId)).toEqual([
        seeded[0].messageId,
        seeded[1].messageId,
        seeded[2].messageId,
        messages[3].messageId,
      ]);
      expect(messages.map((message) => message.content)).toEqual([
        "parts target",
        "first delete target",
        "second delete target",
        `sentinel-${operation}`,
      ]);
      await expect(store.getMessageParts(seeded[0].messageId)).resolves.toEqual([]);
    },
  );

  it("serializes concurrent direct atomic scopes and drains them before commit", async () => {
    const tracked = trackedDatabase(makeDb());
    const store = makeStore(tracked.database);
    const peer = makeStore(tracked.database);
    const conversation = await store.createConversation({ sessionId: "direct-concurrent" });
    tracked.statements.length = 0;

    await store.withTransaction(async () => {
      const outcomes = await Promise.allSettled([
        peer.createMessagesBulk([
          {
            conversationId: conversation.conversationId,
            seq: 0,
            role: "user",
            content: "rolled back concurrent partial",
            tokenCount: 1,
          },
          {
            conversationId: conversation.conversationId,
            seq: 1,
            role: "invalid" as "assistant",
            content: "invalid concurrent",
            tokenCount: 1,
          },
        ]),
        peer.createMessagesBulk([{
          conversationId: conversation.conversationId,
          seq: 2,
          role: "assistant",
          content: "committed concurrent peer",
          tokenCount: 1,
        }]),
      ]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "fulfilled"]);
    });

    expect((await store.getMessages(conversation.conversationId)).map(
      (message) => message.content,
    )).toEqual(["committed concurrent peer"]);
    expect(normalizedTransactionStatements(tracked.statements)).toEqual([
      "BEGIN IMMEDIATE",
      "SAVEPOINT lcm_conversation_atomic",
      "ROLLBACK TO SAVEPOINT lcm_conversation_atomic",
      "RELEASE SAVEPOINT lcm_conversation_atomic",
      "SAVEPOINT lcm_conversation_atomic",
      "RELEASE SAVEPOINT lcm_conversation_atomic",
      "COMMIT",
    ]);
  });

  it("allocates distinct FIFO savepoints and resets ordinals for each transaction", async () => {
    const tracked = trackedDatabase(makeDb());
    const store = makeStore(tracked.database);
    const peer = makeStore(tracked.database);
    const conversation = await store.createConversation({ sessionId: "direct-ordinals" });
    tracked.statements.length = 0;

    await store.withTransaction(async () => {
      await Promise.all([
        peer.createMessagesBulk([{
          conversationId: conversation.conversationId,
          seq: 0,
          role: "user",
          content: "first transaction a",
          tokenCount: 1,
        }]),
        peer.createMessagesBulk([{
          conversationId: conversation.conversationId,
          seq: 1,
          role: "assistant",
          content: "first transaction b",
          tokenCount: 1,
        }]),
      ]);
    });
    await store.withTransaction(async () => {
      await Promise.all([
        peer.createMessagesBulk([{
          conversationId: conversation.conversationId,
          seq: 2,
          role: "user",
          content: "second transaction a",
          tokenCount: 1,
        }]),
        peer.createMessagesBulk([{
          conversationId: conversation.conversationId,
          seq: 3,
          role: "assistant",
          content: "second transaction b",
          tokenCount: 1,
        }]),
      ]);
    });

    expect(tracked.statements.filter(
      (statement) => statement.startsWith("SAVEPOINT"),
    )).toEqual([
      "SAVEPOINT lcm_conversation_atomic_0",
      "SAVEPOINT lcm_conversation_atomic_1",
      "SAVEPOINT lcm_conversation_atomic_0",
      "SAVEPOINT lcm_conversation_atomic_1",
    ]);
    expect((await store.getMessages(conversation.conversationId)).map(
      (message) => message.seq,
    )).toEqual([0, 1, 2, 3]);
  });

  it.each([
    Number.NaN,
    -1,
    Number.MAX_SAFE_INTEGER,
  ])("rejects unsafe transaction-local savepoint ordinal %s before increment", async (ordinal) => {
    const tracked = trackedDatabase(makeDb());
    const store = makeStore(tracked.database);
    const atomicStore = store as unknown as {
      runDirectAtomic<T>(
        active: { db: DatabaseSync; token: symbol; atomicOrdinal: number },
        operation: () => Promise<T> | T,
      ): Promise<T>;
    };
    const active = {
      db: tracked.database,
      token: Symbol("unsafe-ordinal"),
      atomicOrdinal: ordinal,
    };
    tracked.statements.length = 0;
    let operationEntered = false;

    await expect(atomicStore.runDirectAtomic(active, () => {
      operationEntered = true;
    })).rejects.toThrow("conversation transaction savepoint ordinal is unavailable");
    expect(operationEntered).toBe(false);
    expect(Object.is(active.atomicOrdinal, ordinal)).toBe(true);
    expect(tracked.statements).toEqual([]);
  });

  it("rejects recursive direct atomic scopes without deadlocking", async () => {
    const tracked = trackedDatabase(makeDb());
    const store = makeStore(tracked.database);
    const peer = makeStore(tracked.database);
    const conversation = await store.createConversation({ sessionId: "direct-recursive" });
    const atomicStore = store as unknown as {
      withAtomicOperation<T>(operation: () => Promise<T> | T): Promise<T>;
    };
    tracked.statements.length = 0;
    let nestedWriteEntered = false;

    await store.withTransaction(async () => atomicStore.withAtomicOperation(async () => {
      const failure = await peer.createMessagesBulk([{
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "must not enter",
        tokenCount: 1,
      }]).then(
        () => { nestedWriteEntered = true; },
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        "nested atomic conversation operation is not supported",
      );
      return "outer completed";
    }));

    expect(nestedWriteEntered).toBe(false);
    expect(await store.getMessages(conversation.conversationId)).toEqual([]);
    expect(normalizedTransactionStatements(tracked.statements)).toEqual([
      "BEGIN IMMEDIATE",
      "SAVEPOINT lcm_conversation_atomic",
      "RELEASE SAVEPOINT lcm_conversation_atomic",
      "COMMIT",
    ]);
  });

  it("drains a started direct atomic scope before committing its transaction", async () => {
    const tracked = trackedDatabase(makeDb());
    const store = makeStore(tracked.database);
    const atomicStore = store as unknown as {
      withAtomicOperation<T>(operation: () => Promise<T> | T): Promise<T>;
    };
    let releaseAtomic!: () => void;
    let markAtomicEntered!: () => void;
    const atomicRelease = new Promise<void>((resolve) => { releaseAtomic = resolve; });
    const atomicEntered = new Promise<void>((resolve) => { markAtomicEntered = resolve; });
    let atomicSettled = false;
    let startedAtomic = Promise.resolve();

    await store.withTransaction(async () => {
      startedAtomic = atomicStore.withAtomicOperation(async () => {
        markAtomicEntered();
        await atomicRelease;
        atomicSettled = true;
      });
      await atomicEntered;
      queueMicrotask(releaseAtomic);
    });

    await startedAtomic;
    expect(atomicSettled).toBe(true);
    expect(normalizedTransactionStatements(tracked.statements)).toEqual([
      "BEGIN IMMEDIATE",
      "SAVEPOINT lcm_conversation_atomic",
      "RELEASE SAVEPOINT lcm_conversation_atomic",
      "COMMIT",
    ]);
  });

  it("keeps empty direct atomic methods as savepoint-free no-ops", async () => {
    const tracked = trackedDatabase(makeDb());
    const store = makeStore(tracked.database);
    const peer = makeStore(tracked.database);
    const conversation = await store.createConversation({ sessionId: "direct-empty" });
    const message = await store.createMessage({
      conversationId: conversation.conversationId,
      seq: 0,
      role: "system",
      content: "unchanged",
      tokenCount: 1,
    });
    tracked.statements.length = 0;

    await store.withTransaction(async () => {
      await expect(peer.createMessagesBulk([])).resolves.toEqual([]);
      await expect(peer.appendMessages(conversation.conversationId, [])).resolves.toEqual([]);
      await expect(peer.createMessageParts(message.messageId, [])).resolves.toBeUndefined();
      await expect(peer.deleteMessages([])).resolves.toBe(0);
    });

    expect(tracked.statements).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  });

  it("fences outer commit when direct savepoint rollback fails", async () => {
    const raw = makeDb();
    const statements: string[] = [];
    const database = {
      exec: (sql: string): void => {
        statements.push(sql);
        if (sql.startsWith("ROLLBACK TO SAVEPOINT")) {
          throw new Error("injected savepoint rollback failure");
        }
        raw.exec(sql);
      },
      prepare: (sql: string) => raw.prepare(sql),
    } as unknown as DatabaseSync;
    const store = makeStore(database);
    const conversation = await store.createConversation({ sessionId: "direct-rollback-failure" });

    await expect(store.withTransaction(async () => {
      await store.createMessagesBulk([
        {
          conversationId: conversation.conversationId,
          seq: 0,
          role: "user",
          content: "partial before rollback failure",
          tokenCount: 1,
        },
        {
          conversationId: conversation.conversationId,
          seq: 1,
          role: "invalid" as "assistant",
          content: "invalid",
          tokenCount: 1,
        },
      ]).catch(() => undefined);
      await store.createMessage({
        conversationId: conversation.conversationId,
        seq: 10,
        role: "tool",
        content: "outer sentinel must roll back",
        tokenCount: 1,
      });
    })).rejects.toThrow("conversation transaction savepoint recovery failed");

    expect(normalizedTransactionStatements(statements)).toEqual([
      "BEGIN IMMEDIATE",
      "SAVEPOINT lcm_conversation_atomic",
      "ROLLBACK TO SAVEPOINT lcm_conversation_atomic",
      "ROLLBACK",
    ]);
    expect(statements).not.toContain("COMMIT");
    await expect(store.getMessages(conversation.conversationId)).resolves.toEqual([]);
  });

  it("commits after rollback succeeds even if savepoint cleanup release fails", async () => {
    const raw = makeDb();
    const statements: string[] = [];
    let rolledBack = false;
    let rejectCleanupRelease = true;
    const database = {
      exec: (sql: string): void => {
        statements.push(sql);
        if (sql.startsWith("ROLLBACK TO SAVEPOINT")) {
          raw.exec(sql);
          rolledBack = true;
          return;
        }
        if (
          rolledBack
          && rejectCleanupRelease
          && sql.startsWith("RELEASE SAVEPOINT")
        ) {
          rejectCleanupRelease = false;
          throw new Error("injected cleanup release failure");
        }
        raw.exec(sql);
      },
      prepare: (sql: string) => raw.prepare(sql),
    } as unknown as DatabaseSync;
    const store = makeStore(database);
    const conversation = await store.createConversation({ sessionId: "direct-release-failure" });

    await expect(store.withTransaction(async () => {
      await store.createMessagesBulk([
        {
          conversationId: conversation.conversationId,
          seq: 0,
          role: "user",
          content: "partial before cleanup failure",
          tokenCount: 1,
        },
        {
          conversationId: conversation.conversationId,
          seq: 1,
          role: "invalid" as "assistant",
          content: "invalid",
          tokenCount: 1,
        },
      ]).catch(() => undefined);
      await store.createMessage({
        conversationId: conversation.conversationId,
        seq: 10,
        role: "tool",
        content: "committed outer sentinel",
        tokenCount: 1,
      });
    })).resolves.toBeUndefined();

    expect(normalizedTransactionStatements(statements)).toEqual([
      "BEGIN IMMEDIATE",
      "SAVEPOINT lcm_conversation_atomic",
      "ROLLBACK TO SAVEPOINT lcm_conversation_atomic",
      "RELEASE SAVEPOINT lcm_conversation_atomic",
      "COMMIT",
    ]);
    expect((await store.getMessages(conversation.conversationId)).map(
      (message) => message.content,
    )).toEqual(["committed outer sentinel"]);
  });

  it("opens separate transactions for another database and a stale async context", async () => {
    const firstTracked = trackedDatabase(makeDb());
    const secondTracked = trackedDatabase(makeDb());
    const first = makeStore(firstTracked.database);
    const second = makeStore(secondTracked.database);

    await first.withTransaction(() => second.withTransaction(() => "separate"));
    expect(firstTracked.statements).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
    expect(secondTracked.statements).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);

    const conversation = await first.createConversation({ sessionId: "stale-context" });
    let releaseLate!: () => void;
    const lateGate = new Promise<void>((resolve) => { releaseLate = resolve; });
    let lateWrite = Promise.resolve([] as Awaited<ReturnType<typeof first.createMessagesBulk>>);
    await first.withTransaction(() => {
      lateWrite = lateGate.then(() => first.createMessagesBulk([{
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "late",
        tokenCount: 1,
      }]));
    });
    releaseLate();
    await expect(lateWrite).resolves.toHaveLength(1);
    expect(firstTracked.statements).toEqual([
      "BEGIN IMMEDIATE",
      "COMMIT",
      "BEGIN IMMEDIATE",
      "COMMIT",
      "BEGIN IMMEDIATE",
      "COMMIT",
    ]);
  });

  it("serializes async transactions sharing a database handle", async () => {
    const db = makeDb();
    const firstStore = makeStore(db);
    const secondStore = makeStore(db);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = firstStore.withTransaction(async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = secondStore.withTransaction(() => { order.push("second"); });
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});

describe("ConversationStore — persistence boundaries", () => {
  it("returns defensive zero counts when a database adapter returns no aggregate row", async () => {
    const db = {
      prepare: () => ({ get: () => undefined }),
    } as unknown as DatabaseSync;
    const store = makeStore(db);
    await expect(store.countMessagesByIdentity(1, "user", "missing")).resolves.toBe(0);
    await expect(store.getMessageCount(1)).resolves.toBe(0);
    await expect(store.getMessageCountBySessionId("missing")).resolves.toBe(0);
    await expect(store.getMaxSeq(1)).resolves.toBe(0);
  });

  it("preserves messages that are already referenced by summaries", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const conv = await store.createConversation({ sessionId: "referenced-message" });
    const message = await store.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "retained",
      tokenCount: 1,
    });
    db.prepare(`INSERT INTO summaries
      (summary_id, conversation_id, kind, depth, content, token_count, file_ids)
      VALUES (?, ?, 'leaf', 0, 'summary', 1, '[]')`).run("ref-summary", conv.conversationId);
    db.prepare(`INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES (?, ?, 0)`)
      .run("ref-summary", message.messageId);

    expect(await store.deleteMessages([message.messageId])).toBe(0);
    expect(await store.getMessageById(message.messageId)).not.toBeNull();
  });

  it("uses FTS with all filters and maps ranked search rows", async () => {
    const db = makeDb();
    const store = new ConversationStore(db);
    const conv = await store.createConversation({ sessionId: "message-fts" });
    await store.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "persistent searchable phrase",
      tokenCount: 3,
    });

    const results = await store.searchMessages({
      conversationId: conv.conversationId,
      query: "searchable",
      mode: "full_text",
      since: new Date("2000-01-01T00:00:00.000Z"),
      before: new Date("2100-01-01T00:00:00.000Z"),
      limit: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ conversationId: conv.conversationId, role: "user" });
    expect(results[0].createdAt).toBeInstanceOf(Date);
    expect(typeof results[0].rank).toBe("number");
    await expect(store.searchMessages({ query: "searchable", mode: "full_text" }))
      .resolves.toHaveLength(1);
  });

  it("falls back to LIKE after FTS failures and tolerates index cleanup failures", async () => {
    const db = makeDb();
    const store = new ConversationStore(db);
    const conv = await store.createConversation({ sessionId: "message-fts-failure" });
    db.exec("DROP TABLE messages_fts");
    const message = await store.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "assistant",
      content: "fallback needle",
      tokenCount: 2,
    });

    const results = await store.searchMessages({
      conversationId: conv.conversationId,
      query: "needle",
      mode: "full_text",
      since: new Date("2000-01-01T00:00:00.000Z"),
      before: new Date("2100-01-01T00:00:00.000Z"),
    });
    expect(results).toHaveLength(1);
    expect(results[0].snippet).toContain("needle");
    await expect(store.deleteMessages([message.messageId])).resolves.toBe(1);
  });

  it("returns no LIKE results for an empty query", async () => {
    const db = makeDb();
    const store = makeStore(db);
    await expect(store.searchMessages({ query: "", mode: "full_text" })).resolves.toEqual([]);
    const conv = await store.createConversation({ sessionId: "unfiltered-like" });
    await store.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "unfiltered fallback",
      tokenCount: 1,
    });
    await expect(store.searchMessages({ query: "unfiltered", mode: "full_text" }))
      .resolves.toHaveLength(1);
  });

  it("applies conversation and time filters to regex searches", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const conv = await store.createConversation({ sessionId: "message-regex-filters" });
    await store.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "bounded regex value",
      tokenCount: 2,
    });

    expect(await store.searchMessages({
      conversationId: conv.conversationId,
      query: "bounded",
      mode: "regex",
      since: new Date("2000-01-01T00:00:00.000Z"),
      before: new Date("2100-01-01T00:00:00.000Z"),
    })).toHaveLength(1);
  });
});
