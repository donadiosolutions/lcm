import { mkdtempSync, rmSync } from "node:fs";
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
    const tempDir = mkdtempSync(join(process.cwd(), ".superpowers", "grep-session-"));
    tempDirs.push(tempDir);
    ensureProjectDir(tempDir);

    const db = new DatabaseSync(projectDbPath(tempDir));
    runLcmMigrations(db);
    const conversations = new ConversationStore(db);
    const summaries = new SummaryStore(db);
    const older = await conversations.createConversation({ sessionId: "shared-session" });
    const unrelated = await conversations.createConversation({ sessionId: "other-session" });
    const newest = await conversations.createConversation({ sessionId: "shared-session" });
    await conversations.createMessagesBulk([
      { conversationId: older.conversationId, seq: 0, role: "user", content: "needle older", tokenCount: 2 },
      { conversationId: unrelated.conversationId, seq: 0, role: "user", content: "needle unrelated", tokenCount: 2 },
      { conversationId: newest.conversationId, seq: 0, role: "user", content: "needle newest", tokenCount: 2 },
    ]);
    await summaries.insertSummary({
      summaryId: "summary-older",
      conversationId: older.conversationId,
      kind: "leaf",
      content: "needle older summary",
      tokenCount: 3,
    });
    await summaries.insertSummary({
      summaryId: "summary-unrelated",
      conversationId: unrelated.conversationId,
      kind: "leaf",
      content: "needle unrelated summary",
      tokenCount: 3,
    });
    await summaries.insertSummary({
      summaryId: "summary-newest",
      conversationId: newest.conversationId,
      kind: "leaf",
      content: "needle newest summary",
      tokenCount: 3,
    });
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
    } finally {
      await daemon.stop();
    }
  });
});
