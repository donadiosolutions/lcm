import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { ensureProjectDir, projectDbPath } from "../../../src/daemon/project.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";
import { SummaryStore } from "../../../src/store/summary-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("POST /grep session filtering", () => {
  it("filters SQLite messages and summaries to the canonical newest conversation", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-grep-session-"));
    tempDirs.push(tempDir);
    ensureProjectDir(tempDir);

    const db = new DatabaseSync(projectDbPath(tempDir));
    runLcmMigrations(db);
    const conversations = new ConversationStore(db);
    const summaries = new SummaryStore(db);
    const older = await conversations.createConversation({ sessionId: "shared-session" });
    const unrelated = await conversations.createConversation({ sessionId: "other-session" });
    const newest = await conversations.createConversation({ sessionId: "shared-session" });
    const messages = await conversations.createMessagesBulk([
      { conversationId: older.conversationId, seq: 0, role: "user", content: "needle older", tokenCount: 2 },
      { conversationId: unrelated.conversationId, seq: 0, role: "user", content: "needle unrelated", tokenCount: 2 },
      { conversationId: newest.conversationId, seq: 0, role: "user", content: "needle newest", tokenCount: 2 },
    ]);
    const olderSummary = await summaries.insertSummary({
      summaryId: "summary-older",
      conversationId: older.conversationId,
      kind: "leaf",
      content: "needle older summary",
      tokenCount: 3,
    });
    const unrelatedSummary = await summaries.insertSummary({
      summaryId: "summary-unrelated",
      conversationId: unrelated.conversationId,
      kind: "leaf",
      content: "needle unrelated summary",
      tokenCount: 3,
    });
    const newestSummary = await summaries.insertSummary({
      summaryId: "summary-newest",
      conversationId: newest.conversationId,
      kind: "leaf",
      content: "needle newest summary",
      tokenCount: 3,
    });
    const updateMessageTime = db.prepare("UPDATE messages SET created_at = ? WHERE message_id = ?");
    updateMessageTime.run("2025-01-01 00:00:00", messages[0].messageId);
    updateMessageTime.run("2025-01-02 00:00:00", messages[1].messageId);
    updateMessageTime.run("2025-01-03 00:00:00", messages[2].messageId);
    const updateSummaryTime = db.prepare("UPDATE summaries SET created_at = ? WHERE summary_id = ?");
    updateSummaryTime.run("2025-01-01 00:00:00", olderSummary.summaryId);
    updateSummaryTime.run("2025-01-02 00:00:00", unrelatedSummary.summaryId);
    updateSummaryTime.run("2025-01-03 00:00:00", newestSummary.summaryId);
    db.close();

    const daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    try {
      const post = async (body: Record<string, unknown>) => {
        const response = await fetch(`http://127.0.0.1:${daemon.address().port}/grep`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "needle", cwd: tempDir, ...body }),
        });
        expect(response.status).toBe(200);
        return await response.json() as {
          messages: Array<{ conversation_id?: number; conversationId?: number }>;
          summaries: Array<{ conversation_id?: number; conversationId?: number }>;
          totalMatches: number;
        };
      };

      for (const mode of ["full_text", "regex"]) {
        for (const scope of ["messages", "summaries", "both"]) {
          const result = await post({ sessionId: "shared-session", mode, scope });
          const messages = result.messages.map((match) => match.conversationId ?? match.conversation_id);
          const summaryIds = result.summaries.map((match) => match.conversationId ?? match.conversation_id);
          expect(messages).toEqual(scope === "summaries" ? [] : [newest.conversationId]);
          expect(summaryIds).toEqual(scope === "messages" ? [] : [newest.conversationId]);
          expect(result.totalMatches).toBe((scope === "summaries" || scope === "both" ? 1 : 0)
            + (scope === "messages" || scope === "both" ? 1 : 0));
        }
      }

      const unknown = await post({ sessionId: "missing-session", scope: "both" });
      expect(unknown).toEqual({ messages: [], summaries: [], totalMatches: 0 });

      const omitted = await post({ scope: "both" });
      expect(omitted.messages).toHaveLength(3);
      expect(omitted.summaries).toHaveLength(3);
      expect(omitted.totalMatches).toBe(6);

      const sinceSession = await post({
        sessionId: "shared-session",
        since: "2025-01-02T00:00:00Z",
        scope: "both",
      });
      expect(sinceSession.messages.map((match) => match.conversationId ?? match.conversation_id))
        .toEqual([newest.conversationId]);
      expect(sinceSession.summaries.map((match) => match.conversationId ?? match.conversation_id))
        .toEqual([newest.conversationId]);
      expect(sinceSession.totalMatches).toBe(2);
    } finally {
      await daemon.stop();
    }
  });

  it("applies inclusive since boundaries to SQLite messages and summaries", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-grep-since-"));
    tempDirs.push(tempDir);
    ensureProjectDir(tempDir);

    const db = new DatabaseSync(projectDbPath(tempDir));
    runLcmMigrations(db);
    const conversations = new ConversationStore(db);
    const summaries = new SummaryStore(db);
    const conversation = await conversations.createConversation({ sessionId: "since-session" });
    const messages = await conversations.createMessagesBulk([
      { conversationId: conversation.conversationId, seq: 0, role: "user", content: "needle before", tokenCount: 2 },
      { conversationId: conversation.conversationId, seq: 1, role: "user", content: "needle boundary", tokenCount: 2 },
      { conversationId: conversation.conversationId, seq: 2, role: "user", content: "needle later", tokenCount: 2 },
    ]);
    const summaryBefore = await summaries.insertSummary({
      summaryId: "summary-before",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "needle before summary",
      tokenCount: 3,
    });
    const summaryBoundary = await summaries.insertSummary({
      summaryId: "summary-boundary",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "needle boundary summary",
      tokenCount: 3,
    });
    const summaryLater = await summaries.insertSummary({
      summaryId: "summary-later",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "needle later summary",
      tokenCount: 3,
    });
    const updateMessageTime = db.prepare("UPDATE messages SET created_at = ? WHERE message_id = ?");
    updateMessageTime.run("2025-01-01 23:59:59", messages[0].messageId);
    updateMessageTime.run("2025-01-02 00:00:00", messages[1].messageId);
    updateMessageTime.run("2025-01-02 00:00:01", messages[2].messageId);
    const updateSummaryTime = db.prepare("UPDATE summaries SET created_at = ? WHERE summary_id = ?");
    updateSummaryTime.run("2025-01-01 23:59:59", summaryBefore.summaryId);
    updateSummaryTime.run("2025-01-02 00:00:00", summaryBoundary.summaryId);
    updateSummaryTime.run("2025-01-02 00:00:01", summaryLater.summaryId);
    db.close();

    const daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    try {
      for (const mode of ["full_text", "regex"] as const) {
        for (const scope of ["messages", "summaries", "both"] as const) {
          const response = await fetch(`http://127.0.0.1:${daemon.address().port}/grep`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: "needle",
              cwd: tempDir,
              mode,
              scope,
              since: "2025-01-02T00:00:00Z",
            }),
          });
          expect(response.status).toBe(200);
          const result = await response.json() as {
            messages: Array<{ message_id?: number; messageId?: number }>;
            summaries: Array<{ summary_id?: string; summaryId?: string }>;
            totalMatches: number;
          };
          const messageIds = result.messages.map((match) => match.messageId ?? match.message_id);
          const summaryIds = result.summaries.map((match) => match.summaryId ?? match.summary_id);
          expect(messageIds).toEqual(scope === "summaries"
            ? []
            : expect.arrayContaining([messages[1].messageId, messages[2].messageId]));
          expect(messageIds).not.toContain(messages[0].messageId);
          expect(summaryIds).toHaveLength(scope === "messages" ? 0 : 2);
          expect(summaryIds).toEqual(scope === "messages"
            ? []
            : expect.arrayContaining([summaryBoundary.summaryId, summaryLater.summaryId]));
          expect(summaryIds).not.toContain(summaryBefore.summaryId);
          expect(result.totalMatches).toBe((scope === "summaries" ? 0 : 2) + (scope === "messages" ? 0 : 2));
        }
      }
    } finally {
      await daemon.stop();
    }
  });

  it("accepts the normalized year-0001 lower bound across modes and scopes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-grep-ancient-since-"));
    tempDirs.push(tempDir);
    ensureProjectDir(tempDir);

    const db = new DatabaseSync(projectDbPath(tempDir));
    runLcmMigrations(db);
    const conversations = new ConversationStore(db);
    const summaries = new SummaryStore(db);
    const conversation = await conversations.createConversation({ sessionId: "ancient-since-session" });
    const [message] = await conversations.createMessagesBulk([
      { conversationId: conversation.conversationId, seq: 0, role: "user", content: "ancient bound needle", tokenCount: 2 },
    ]);
    const summary = await summaries.insertSummary({
      summaryId: "ancient-bound-summary",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "ancient bound needle summary",
      tokenCount: 3,
    });
    db.prepare("UPDATE messages SET created_at = ? WHERE message_id = ?")
      .run("2025-01-01 00:00:00", message.messageId);
    db.prepare("UPDATE summaries SET created_at = ? WHERE summary_id = ?")
      .run("2025-01-01 00:00:00", summary.summaryId);
    db.close();

    const daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    try {
      for (const mode of ["full_text", "regex"] as const) {
        for (const scope of ["messages", "summaries", "both"] as const) {
          const response = await fetch(`http://127.0.0.1:${daemon.address().port}/grep`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: "needle",
              cwd: tempDir,
              mode,
              scope,
              since: "0001-01-01T00:00:00Z",
            }),
          });
          expect(response.status).toBe(200);
          const result = await response.json() as {
            messages: Array<{ message_id?: number; messageId?: number }>;
            summaries: Array<{ summary_id?: string; summaryId?: string }>;
            totalMatches: number;
          };
          expect(result.messages).toHaveLength(scope === "summaries" ? 0 : 1);
          expect(result.summaries).toHaveLength(scope === "messages" ? 0 : 1);
          expect(result.totalMatches).toBe(scope === "both" ? 2 : 1);
        }
      }

      const rejected = await fetch(`http://127.0.0.1:${daemon.address().port}/grep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "needle",
          cwd: tempDir,
          since: "9999-12-31T23:59:00.000-00:01",
        }),
      });
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({ error: "invalid since" });
    } finally {
      await daemon.stop();
    }
  });
});
