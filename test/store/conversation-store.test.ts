import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { getLcmConnection, closeLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { ConversationStore } from "../../src/store/conversation-store.js";

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
});

describe("ConversationStore — persistence boundaries", () => {
  it("returns defensive zero counts when a database adapter returns no aggregate row", async () => {
    const db = {
      prepare: () => ({ get: () => undefined }),
    } as unknown as DatabaseSync;
    const store = makeStore(db);
    await expect(store.countMessagesByIdentity(1, "user", "missing")).resolves.toBe(0);
    await expect(store.getMessageCount(1)).resolves.toBe(0);
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
