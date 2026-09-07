import { beforeAll, describe, expect, it, vi } from "vitest";
import { batchCompact, findUncompacted } from "../../src/batch-compact.js";
import { withCliProjectStorage } from "../../src/cli-storage.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { assertHarnessReady } from "./harness.js";
import { withSelectedPostgreSqlProject } from "./operational-fixture.js";

beforeAll(assertHarnessReady);

describe("PostgreSQL 18 compact discovery", { timeout: 120_000 }, () => {
  it("discovers selected repositories without SQLite metadata and preserves replay eligibility", async () => {
    await withSelectedPostgreSqlProject("compact-discovery", async ({ projectPath }) => {
      await withCliProjectStorage(projectPath, {}, async ({ storage }) => {
        for (const [sessionId, count, tokenCount] of [
          ["eligible", 9, 100], ["protected", 8, 100], ["small", 9, 1],
          ["summarized", 9, 100], ["empty", 0, 100],
        ] as const) {
          const conversation = await storage.conversations.createConversation({ sessionId });
          const messages = await storage.conversations.appendMessages(conversation.conversationId,
            Array.from({ length: count }, (_, index) => ({ role: "user" as const, content: `message ${index}`, tokenCount })));
          if (sessionId === "summarized") {
            for (let index = 0; index < 3; index++) {
              const summary = await storage.summaries.insertSummary({
                summaryId: `summary-${index}`, conversationId: conversation.conversationId,
                kind: "leaf", content: "summary", tokenCount: 1000,
              });
              await storage.context.appendContextSummary(conversation.conversationId, summary.summaryId);
            }
            await storage.context.appendContextMessages(conversation.conversationId, messages.slice(3).map(message => message.messageId));
          } else {
            await storage.context.appendContextMessages(conversation.conversationId, messages.map(message => message.messageId));
          }
        }
      });
      expect(await findUncompacted(100, true, projectPath)).toEqual([
        expect.objectContaining({ cwd: projectPath, sessionId: "eligible", messages: 9, tokens: 900 }),
      ]);
      expect((await findUncompacted(100, true, projectPath, true)).map(conversation => conversation.sessionId))
        .toEqual(["eligible", "summarized"]);
      expect(await findUncompacted(1000, true, projectPath)).toEqual([]);
      expect((await findUncompacted(100, true)).map(conversation => conversation.sessionId)).toEqual(["eligible"]);
      const post = vi.spyOn(DaemonClient.prototype, "post").mockResolvedValue({ actionTaken: true, tokensBefore: 900, tokensAfter: 100 });
      const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        expect(await batchCompact({ minTokens: 100, dryRun: true, port: 3737 })).toEqual({
          compacted: 0, unchanged: 0, skipped: 0, failures: 0, compactedProjects: [],
        });
        expect(post).not.toHaveBeenCalled();
        expect(await batchCompact({ minTokens: 100, dryRun: false, port: 3737 })).toEqual({
          compacted: 1, unchanged: 0, skipped: 0, failures: 0, compactedProjects: [projectPath],
        });
        expect(post).toHaveBeenCalledWith("/compact", expect.objectContaining({ session_id: "eligible", cwd: projectPath }));
      } finally { output.mockRestore(); post.mockRestore(); }
    });
  });
});
