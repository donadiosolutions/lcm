import { describe, it } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import {
  createSqliteRepositories,
  createSqliteRepositoryStores,
} from "../../src/storage/sqlite/repositories.js";
import { createTemporaryDatabase } from "../fixtures/runtime.js";
import { exerciseLexicalSearchRepositoryConformance } from "./lexical-search-conformance.js";

describe("SQLite lexical-search golden conformance", () => {
  it("exercises the backend-neutral lexical fixtures", async () => {
    const database = createTemporaryDatabase();
    runLcmMigrations(database);
    const projectId = "sqlite-owner-project";
    const repositories = createSqliteRepositories(
      createSqliteRepositoryStores(database),
      projectId,
      async (_domain, _operation, callback) => callback()
    );

    const primary = await repositories.conversations.createConversation({
      sessionId: "lexical-primary",
    });
    const secondary = await repositories.conversations.createConversation({
      sessionId: "lexical-secondary",
    });
    const accented = await repositories.conversations.createMessage({
      conversationId: primary.conversationId,
      seq: 0,
      role: "user",
      content: "Café βeta foo_bar() C++ needle accented",
      tokenCount: 6,
    });
    const regex = await repositories.conversations.createMessage({
      conversationId: primary.conversationId,
      seq: 1,
      role: "assistant",
      content: "punctuation [ok] needle-2046",
      tokenCount: 3,
    });
    const isolated = await repositories.conversations.createMessage({
      conversationId: secondary.conversationId,
      seq: 0,
      role: "tool",
      content: "isolated needle",
      tokenCount: 2,
    });

    const accentedSummary = await repositories.summaries.insertSummary({
      summaryId: "lexical-summary-accented",
      conversationId: primary.conversationId,
      kind: "leaf",
      content: "Café summary needle",
      tokenCount: 3,
    });
    const regexSummary = await repositories.summaries.insertSummary({
      summaryId: "lexical-summary-regex",
      conversationId: primary.conversationId,
      kind: "condensed",
      content: "punctuation summary-2047 needle",
      tokenCount: 3,
    });
    const isolatedSummary = await repositories.summaries.insertSummary({
      summaryId: "lexical-summary-isolated",
      conversationId: secondary.conversationId,
      kind: "leaf",
      content: "isolated summary needle",
      tokenCount: 3,
    });

    const sourceProjectId = "source-project-a";
    const isolatedSourceProjectId = "source-project-b";
    const contentMemoryId = await repositories.promotedMemory.insert({
      content: "primarydurable durable memory",
      tags: ["architecture"],
      sourceProjectId,
      confidence: 0.8,
    });
    const tagMemoryId = await repositories.promotedMemory.insert({
      content: "unrelated recollection",
      tags: ["tagonly", "required"],
      sourceProjectId,
      confidence: 0.7,
    });
    const isolatedMemoryId = await repositories.promotedMemory.insert({
      content: "isolateddurable durable memory",
      tags: ["isolated"],
      sourceProjectId: isolatedSourceProjectId,
      confidence: 0.6,
    });

    await exerciseLexicalSearchRepositoryConformance(
      repositories.lexicalSearch,
      {
        primaryConversationId: primary.conversationId,
        secondaryConversationId: secondary.conversationId,
        messageIds: {
          accented: accented.messageId,
          regex: regex.messageId,
          isolated: isolated.messageId,
        },
        summaryIds: {
          accented: accentedSummary.summaryId,
          regex: regexSummary.summaryId,
          isolated: isolatedSummary.summaryId,
        },
        memoryIds: {
          content: contentMemoryId,
          tagOnly: tagMemoryId,
          isolated: isolatedMemoryId,
        },
        sourceProjectId,
        isolatedSourceProjectId,
        searchTimestamp: accented.createdAt,
      }
    );
  });
});
