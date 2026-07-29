import { expect, it } from "vitest";
import type { ProjectStorage, StorageBackendFactory } from "../../src/storage/contracts.js";
import { StorageOperationError } from "../../src/storage/errors.js";
import { createRetrievalEngine, RetrievalEngine } from "../../src/retrieval.js";
import { deduplicateAndInsert } from "../../src/promotion/dedup.js";
import type { ProjectIdentity } from "../../src/project-map.js";
import { exerciseConversationRepositoryConformance } from "./conversation-conformance.js";

export interface StorageContractHarness {
  factory: StorageBackendFactory;
  identity(label: string): ProjectIdentity;
  open(label: string): Promise<ProjectStorage>;
}

export function defineCoreStorageConformance(
  createHarness: () => StorageContractHarness,
): void {
  it("round-trips every core repository domain with stable ordering", async () => {
    const harness = createHarness();
    const storage = await harness.open("core");
    expect(createRetrievalEngine(storage)).toBeInstanceOf(RetrievalEngine);
    const { first, second, messages, third } =
      await exerciseConversationRepositoryConformance(storage.conversations);

    await storage.context.appendContextMessages(first.conversationId, messages.map((row) => row.messageId));
    await storage.context.appendContextMessage(first.conversationId, third.messageId);
    await storage.context.appendContextMessages(first.conversationId, []);
    const leaf = await storage.summaries.insertSummary({
      summaryId: "leaf-1",
      conversationId: first.conversationId,
      kind: "leaf",
      content: "leaf needle",
      tokenCount: 5,
      fileIds: [
        "file_aaaaaaaaaaaaaaaa",
        "file_aaaaaaaaaaaaaaaa",
        "file_bbbbbbbbbbbbbbbb",
      ],
      earliestAt: new Date("2026-01-01T00:00:00Z"),
      latestAt: new Date("2026-01-02T00:00:00Z"),
    });
    const parent = await storage.summaries.insertSummary({
      summaryId: "parent-1",
      conversationId: first.conversationId,
      kind: "condensed",
      content: "parent",
      tokenCount: 6,
    });
    const earliestOnly = await storage.summaries.insertSummary({
      summaryId: "earliest-only",
      conversationId: second.conversationId,
      kind: "leaf",
      content: "earliest only",
      tokenCount: 2,
      earliestAt: new Date("2026-01-03T00:00:00Z"),
    });
    const latestOnly = await storage.summaries.insertSummary({
      summaryId: "latest-only",
      conversationId: second.conversationId,
      kind: "leaf",
      content: "latest only",
      tokenCount: 2,
      latestAt: new Date("2026-01-04T00:00:00Z"),
    });
    expect(earliestOnly).toMatchObject({
      earliestAt: new Date("2026-01-03T00:00:00Z"),
      latestAt: null,
    });
    expect(latestOnly).toMatchObject({
      earliestAt: null,
      latestAt: new Date("2026-01-04T00:00:00Z"),
    });
    await storage.summaries.linkSummaryToMessages(leaf.summaryId, messages.map((row) => row.messageId));
    await storage.summaries.linkSummaryToMessages(leaf.summaryId, []);
    await storage.summaries.linkSummaryToParents(leaf.summaryId, [parent.summaryId]);
    await storage.summaries.linkSummaryToParents(parent.summaryId, []);
    expect(await storage.summaries.getSummary("missing")).toBeNull();
    expect(await storage.summaries.getSummary(leaf.summaryId)).toMatchObject({
      fileIds: [
        "file_aaaaaaaaaaaaaaaa",
        "file_aaaaaaaaaaaaaaaa",
        "file_bbbbbbbbbbbbbbbb",
      ],
    });
    expect(await storage.summaries.getSummariesByConversation(first.conversationId)).toHaveLength(2);
    expect(await storage.summaries.listRecentSummaries(1)).toHaveLength(1);
    expect((await storage.summaries.listRecentSummariesForSession("session-a", 5)).map((row) => row.depth)).toEqual([1, 0]);
    expect(await storage.summaries.listRecentSummariesForSession("missing", 5)).toEqual([]);
    expect(await storage.summaries.getSummaryMessages(leaf.summaryId)).toEqual(messages.map((row) => row.messageId));
    expect((await storage.summaries.getSummaryChildren(parent.summaryId))[0]?.summaryId).toBe(leaf.summaryId);
    expect((await storage.summaries.getSummaryParents(leaf.summaryId))[0]?.summaryId).toBe(parent.summaryId);
    expect((await storage.summaries.getSummarySubtree(parent.summaryId)).map((row) => row.summaryId)).toEqual(["parent-1", "leaf-1"]);
    await storage.context.appendContextSummary(first.conversationId, leaf.summaryId);
    expect(await storage.context.getDistinctDepthsInContext(first.conversationId)).toEqual([0]);
    expect(await storage.context.getDistinctDepthsInContext(first.conversationId, { maxOrdinalExclusive: Infinity })).toEqual([0]);
    expect(await storage.context.getContextTokenCount(first.conversationId)).toBe(14);
    expect((await storage.context.getContextItems(first.conversationId)).map((row) => row.ordinal)).toEqual([0, 1, 2, 3]);
    await storage.context.replaceContextRangeWithSummary({
      conversationId: first.conversationId,
      startOrdinal: 0,
      endOrdinal: 2,
      summaryId: parent.summaryId,
    });
    expect((await storage.context.getContextItems(first.conversationId)).map((row) => row.ordinal)).toEqual([0, 1]);

    const file = await storage.largeFiles.insertLargeFile({
      fileId: "file-1",
      conversationId: first.conversationId,
      fileName: "a.txt",
      storageUri: "local:a",
    });
    expect(file.fileName).toBe("a.txt");
    expect(await storage.largeFiles.getLargeFile("missing")).toBeNull();
    expect(await storage.largeFiles.getLargeFilesByConversation(first.conversationId)).toHaveLength(1);

    const memoryId = await storage.promotedMemory.insert({
      content: "durable needle",
      tags: ["architecture", "Foo", "foo", "", " spaced ", "Foo"],
      metadata: { origin: "conformance", nested: { revision: 1 } },
      sourceSummaryId: "external-summary",
      sourceProjectId: "source-a",
      sessionId: "session-a",
      ...({ projectId: "caller-controlled" } as object),
    } as Parameters<typeof storage.promotedMemory.insert>[0]);
    expect(await storage.promotedMemory.getById(memoryId)).toMatchObject({
      tags: ["architecture", "Foo", "foo", "", " spaced ", "Foo"],
      metadata: { nested: { revision: 1 }, origin: "conformance" },
      projectId: "source-a",
      sourceSummaryId: "external-summary",
    });
    expect(await storage.promotedMemory.getById("missing")).toBeNull();
    expect(await storage.promotedMemory.getAll({
      sourceProjectId: "source-a",
      tags: ["architecture"],
      ...({ projectId: "caller-controlled" } as object),
    })).toHaveLength(1);
    expect(await storage.promotedMemory.getAll({ tags: ["Foo"] })).toHaveLength(1);
    expect(await storage.promotedMemory.getAll({ tags: ["foo"] })).toHaveLength(1);
    expect(await storage.promotedMemory.getAll({ tags: ["FOO"] })).toEqual([]);
    expect(await storage.promotedMemory.getAll({ sourceProjectId: "missing" })).toEqual([]);
    expect(await storage.promotedMemory.getAll({ sourceProjectId: "" })).toEqual([]);
    expect(await storage.promotedMemory.getAll({
      since: "1970-01-01T00:00:00Z",
    })).toHaveLength(1);
    expect(await storage.promotedMemory.listContentPrefixes(5)).toEqual(["durable needle"]);
    await storage.promotedMemory.update(memoryId, {
      content: "updated needle",
      confidence: 0.8,
      tags: ["updated"],
      metadata: { revision: 2 },
    });
    expect(await storage.promotedMemory.findStale({
      staleAfterDays: -1,
      staleSurfacingWithoutUseLimit: 2,
      sourceProjectId: "source-a",
    })).toHaveLength(1);
    expect(await storage.promotedMemory.findStale({
      staleAfterDays: -1,
      staleSurfacingWithoutUseLimit: 2,
      sourceProjectId: "missing",
    })).toEqual([]);
    expect(await storage.promotedMemory.findStale({
      staleAfterDays: -1,
      staleSurfacingWithoutUseLimit: 2,
      sourceProjectId: "",
    })).toEqual([]);
    await storage.promotedMemory.archive(memoryId);
    expect(await storage.promotedMemory.getAll()).toEqual([]);
    await storage.promotedMemory.revive(memoryId);
    expect(await storage.promotedMemory.getAll()).toHaveLength(1);
    await storage.transaction(async (tx) => {
      await tx.promotedMemory.archive(memoryId);
      await tx.promotedMemory.revive(memoryId);
      await tx.context.replaceContextRangeWithSummary({
        conversationId: first.conversationId,
        startOrdinal: 0,
        endOrdinal: 1,
        summaryId: leaf.summaryId,
      });
    });

    await storage.recall.logSurfacing([memoryId], "session-a");
    await storage.recall.logSurfacing(["id-1", "id-x", "id-1"], null);
    await storage.recall.logSurfacing([], null);
    expect((await storage.recall.getFeedback([memoryId])).get(memoryId)?.surfacingCount).toBe(1);
    const orphanFeedback = await storage.recall.getFeedback(["id-1", "id-x"]);
    expect(orphanFeedback.get("id-1")?.surfacingCount).toBe(2);
    expect(orphanFeedback.get("id-x")?.surfacingCount).toBe(1);
    expect((await storage.recall.getStats()).memoriesSurfaced).toBe(3);
    await storage.redactionAdmin.upsertCounts({ gitleaks: 1, builtIn: 1, global: 1, project: 1 });
    await storage.redactionAdmin.upsertCounts({ gitleaks: 0, builtIn: 0, global: 0, project: 0 });
    expect(await storage.redactionAdmin.getCounts()).toEqual({
      gitleaks: 1,
      builtIn: 1,
      global: 1,
      project: 1,
      total: 4,
    });
    await storage.coordination.recordSessionIngest("session-a", 3);
    expect(await storage.coordination.getSessionIngest("session-a")).toMatchObject({ messageCount: 3 });
    expect(await storage.coordination.getSessionIngest("missing")).toBeNull();
    const instructionScope = {
      clientName: "codex",
      sessionId: "session-a",
      worktreePath: "/repo/worktree-a",
      cwdPath: "/repo/worktree-a/src",
    } as const;
    expect(await storage.coordination.getSessionInstructions(instructionScope)).toBeNull();
    await storage.coordination.upsertSessionInstructions(
      instructionScope,
      "current",
      "hash-2",
    );
    expect(await storage.coordination.getSessionInstructions(instructionScope))
      .toMatchObject({ ...instructionScope, content: "current" });
    await storage.coordination.deleteSessionInstructions(instructionScope);
    expect(await storage.coordination.getSessionInstructions(instructionScope)).toBeNull();

    expect(await storage.lexicalSearch.searchMessages({ query: "needle", mode: "full_text" })).not.toEqual([]);
    expect(await storage.lexicalSearch.searchMessages({ query: "alpha", mode: "regex" })).not.toEqual([]);
    expect(await storage.lexicalSearch.searchSummaries({ query: "needle", mode: "full_text" })).not.toEqual([]);
    expect(await storage.lexicalSearch.searchSummaries({ query: "leaf", mode: "regex" })).not.toEqual([]);
    expect(await storage.lexicalSearch.searchPromoted("updated", 5)).toHaveLength(1);
    expect(await storage.lexicalSearch.searchPromoted("updated", 5, undefined, "source-a")).toHaveLength(1);
    expect(await storage.lexicalSearch.searchPromoted("updated", 5, undefined, "missing")).toEqual([]);

    expect(await storage.conversations.deleteMessages([messages[0].messageId, third.messageId])).toBe(1);
    expect(await storage.conversations.deleteMessages([])).toBe(0);
    await storage.promotedMemory.deleteById(memoryId);
    expect(await storage.promotedMemory.getById(memoryId)).toBeNull();
    expect((await storage.recall.getFeedback([memoryId])).get(memoryId)?.surfacingCount).toBe(1);
    expect(await storage.redactionAdmin.purgeProjectState()).toMatchObject({
      promotedMemories: 0,
      promotedTags: 0,
      recallSurfacings: 4,
      redactionCounters: 4,
      sessionIngestLogs: 1,
      sessionInstructions: 0,
    });
    expect(await storage.conversations.getConversation(first.conversationId))
      .toMatchObject({ sessionId: "session-a" });
    await storage.close();
    await harness.factory.close();
  });

  it("commits, rolls back, rejects nested and escaped scopes, and serializes FIFO", async () => {
    const harness = createHarness();
    const storage = await harness.open("transactions");
    await storage.transaction(async (tx) => {
      const conversation = await tx.conversations.createConversation({ sessionId: "committed" });
      await tx.conversations.appendMessages(conversation.conversationId, [
        { role: "user", content: "ok", tokenCount: 1 },
        { role: "assistant", content: "still ok", tokenCount: 2 },
      ]);
    });
    const committed = await storage.conversations.getConversationBySessionId("committed");
    expect(committed).not.toBeNull();
    expect(await storage.conversations.getMessageCount(committed!.conversationId)).toBe(2);

    await expect(storage.transaction(async (tx) => {
      const conversation = await tx.conversations.createConversation({ sessionId: "rolled-back" });
      await tx.conversations.createMessage({
        conversationId: conversation.conversationId,
        seq: 0,
        role: "invalid" as "user",
        content: "contains /secret/path and postgresql://user:pass@example.test/db",
        tokenCount: 1,
      });
    })).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED", domain: "conversations" });
    expect(await storage.conversations.getConversationBySessionId("rolled-back")).toBeNull();

    const atomicConversation = await storage.conversations.createConversation({ sessionId: "atomic-methods" });
    await expect(storage.conversations.createMessagesBulk([
      {
        conversationId: atomicConversation.conversationId,
        seq: 0,
        role: "user",
        content: "must roll back",
        tokenCount: 1,
      },
      {
        conversationId: atomicConversation.conversationId,
        seq: 0,
        role: "assistant",
        content: "duplicate sequence",
        tokenCount: 1,
      },
    ])).rejects.toMatchObject({ domain: "conversations" });
    expect(await storage.conversations.getMessages(atomicConversation.conversationId)).toEqual([]);

    const partsMessage = await storage.conversations.createMessage({
      conversationId: atomicConversation.conversationId,
      seq: 0,
      role: "assistant",
      content: "parts",
      tokenCount: 1,
    });
    await expect(storage.conversations.createMessageParts(partsMessage.messageId, [
      { sessionId: "atomic-methods", partType: "text", ordinal: 0, textContent: "must roll back" },
      { sessionId: "atomic-methods", partType: "reasoning", ordinal: 0, textContent: "duplicate ordinal" },
    ])).rejects.toMatchObject({ domain: "conversations" });
    expect(await storage.conversations.getMessageParts(partsMessage.messageId)).toEqual([]);

    await expect(storage.transaction(async (tx) => {
      await tx.conversations.appendMessages(atomicConversation.conversationId, [
        { role: "user", content: "outer transaction", tokenCount: 2 },
      ]);
      await tx.conversations.createMessagesBulk([
        {
          conversationId: atomicConversation.conversationId,
          seq: 2,
          role: "assistant",
          content: "outer bulk",
          tokenCount: 2,
        },
      ]);
      throw new Error("force outer rollback");
    })).rejects.toMatchObject({ domain: "transaction" });
    expect((await storage.conversations.getMessages(atomicConversation.conversationId))
      .map((row) => row.content)).toEqual(["parts"]);

    await storage.transaction(async (tx) => {
      await Promise.all([
        tx.conversations.createMessagesBulk([{
          conversationId: atomicConversation.conversationId,
          seq: 1,
          role: "user",
          content: "concurrent commit a",
          tokenCount: 2,
        }]),
        tx.conversations.createMessagesBulk([{
          conversationId: atomicConversation.conversationId,
          seq: 2,
          role: "assistant",
          content: "concurrent commit b",
          tokenCount: 2,
        }]),
      ]);
    });
    expect((await storage.conversations.getMessages(atomicConversation.conversationId))
      .map((row) => row.content)).toEqual([
      "parts",
      "concurrent commit a",
      "concurrent commit b",
    ]);

    await expect(storage.transaction(async (tx) => {
      await Promise.all([
        tx.conversations.createMessagesBulk([{
          conversationId: atomicConversation.conversationId,
          seq: 3,
          role: "user",
          content: "must roll back with concurrent peer",
          tokenCount: 2,
        }]),
        tx.conversations.createMessagesBulk([{
          conversationId: atomicConversation.conversationId,
          seq: 4,
          role: "assistant",
          content: "duplicate concurrent a",
          tokenCount: 2,
        }, {
          conversationId: atomicConversation.conversationId,
          seq: 4,
          role: "tool",
          content: "duplicate concurrent b",
          tokenCount: 2,
        }]),
      ]);
    })).rejects.toMatchObject({ domain: "conversations" });
    expect((await storage.conversations.getMessages(atomicConversation.conversationId))
      .map((row) => row.content)).toEqual([
      "parts",
      "concurrent commit a",
      "concurrent commit b",
    ]);

    const contextConversation = await storage.conversations.createConversation({ sessionId: "context-rollback" });
    const contextMessage = await storage.conversations.createMessage({
      conversationId: contextConversation.conversationId,
      seq: 0,
      role: "user",
      content: "preserved context",
      tokenCount: 2,
    });
    await storage.context.appendContextMessage(contextConversation.conversationId, contextMessage.messageId);
    await expect(storage.transaction(async (tx) => tx.context.replaceContextRangeWithSummary({
      conversationId: contextConversation.conversationId,
      startOrdinal: 0,
      endOrdinal: 0,
      summaryId: "missing-summary",
    }))).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED", domain: "context" });
    expect(await storage.context.getContextItems(contextConversation.conversationId))
      .toMatchObject([{ messageId: contextMessage.messageId, ordinal: 0 }]);

    await expect(storage.context.appendContextMessage(999_999, 999_999))
      .rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED", domain: "context" });
    await expect(storage.largeFiles.insertLargeFile({
      fileId: "missing-conversation",
      conversationId: 999_999,
      fileName: "missing.txt",
      storageUri: "local:missing",
    })).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED", domain: "large-files" });

    await expect(storage.transaction(async () => storage.transaction(async () => undefined)))
      .rejects.toMatchObject({ code: "STORAGE_NESTED_TRANSACTION" });
    const otherProject = await harness.open("transactions-other");
    await expect(storage.transaction(async (tx) => {
      await tx.conversations.createConversation({ sessionId: "cross-project-outer" });
      await otherProject.transaction(async (otherTx) => {
        await otherTx.conversations.createConversation({ sessionId: "cross-project-inner" });
      });
    })).rejects.toMatchObject({ code: "STORAGE_NESTED_TRANSACTION" });
    expect(await storage.conversations.getConversationBySessionId("cross-project-outer")).toBeNull();
    expect(await otherProject.conversations.getConversationBySessionId("cross-project-inner")).toBeNull();
    await Promise.all([
      expect(storage.transaction(async (tx) => {
        await tx.conversations.createConversation({ sessionId: "cross-project-call-a" });
        await otherProject.conversations.createConversation({ sessionId: "cross-project-call-b" });
      })).rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" }),
      expect(otherProject.transaction(async (tx) => {
        await tx.conversations.createConversation({ sessionId: "cross-project-call-c" });
        await storage.conversations.createConversation({ sessionId: "cross-project-call-d" });
      })).rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" }),
    ]);
    expect(await storage.conversations.getConversationBySessionId("cross-project-call-a")).toBeNull();
    expect(await storage.conversations.getConversationBySessionId("cross-project-call-d")).toBeNull();
    expect(await otherProject.conversations.getConversationBySessionId("cross-project-call-b")).toBeNull();
    expect(await otherProject.conversations.getConversationBySessionId("cross-project-call-c")).toBeNull();
    await otherProject.close();
    await expect(storage.transaction(async () => storage.conversations.listConversations()))
      .rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
    await expect(storage.transaction(async () => storage.close()))
      .rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
    expect(await storage.health()).toMatchObject({ status: "healthy" });

    let escaped!: Parameters<Parameters<ProjectStorage["transaction"]>[0]>[0];
    await storage.transaction(async (tx) => { escaped = tx; });
    await expect(escaped.conversations.listConversations())
      .rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });

    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const first = storage.transaction(async (tx) => {
      order.push("first-enter");
      entered();
      await releasePromise;
      await tx.conversations.createConversation({ sessionId: "fifo-1" });
      order.push("first-exit");
    });
    await enteredPromise;
    const second = storage.transaction(async (tx) => {
      order.push("second-enter");
      await tx.conversations.createConversation({ sessionId: "fifo-2" });
    });
    const ordinary = storage.conversations.listConversations().then(() => { order.push("ordinary"); });
    await Promise.resolve();
    expect(order).toEqual(["first-enter"]);
    release();
    await Promise.all([first, second, ordinary]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter", "ordinary"]);

    let releaseOpen!: () => void;
    let transactionEntered!: () => void;
    const openRelease = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const transactionStarted = new Promise<void>((resolve) => { transactionEntered = resolve; });
    const rollingBack = storage.transaction(async (tx) => {
      await tx.conversations.createConversation({ sessionId: "open-during-transaction" });
      transactionEntered();
      await openRelease;
      throw new Error("rollback before queued open");
    });
    await transactionStarted;
    let secondScopeOpened = false;
    const secondScopePromise = harness.open("transactions").then((opened) => {
      secondScopeOpened = true;
      return opened;
    });
    await Promise.resolve();
    expect(secondScopeOpened).toBe(false);
    releaseOpen();
    await expect(rollingBack).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    const secondScope = await secondScopePromise;
    expect(await secondScope.conversations.getConversationBySessionId("open-during-transaction")).toBeNull();
    await secondScope.close();

    const concurrent = {
      transaction: storage.transaction.bind(storage),
      content: "concurrent transaction deduplication",
      tags: ["concurrency"],
      depth: 0,
      confidence: 0.8,
      thresholds: { dedupBm25Threshold: 0.000001, dedupCandidateLimit: 10 },
    };
    const [firstId, secondId] = await Promise.all([
      deduplicateAndInsert(concurrent),
      deduplicateAndInsert(concurrent),
    ]);
    expect(secondId).toBe(firstId);
    expect(await storage.promotedMemory.getAll({ tags: ["concurrency"] })).toHaveLength(1);
    await storage.close();
    await harness.factory.close();
  });

  it("isolates projects and implements health and idempotent lifecycle", async () => {
    const harness = createHarness();
    const firstIdentity = harness.identity("one");
    expect(await harness.factory.projectExists(firstIdentity)).toBe(false);
    const first = await harness.open("one");
    expect(await harness.factory.projectExists(firstIdentity)).toBe(true);
    const second = await harness.open("two");
    const firstAgain = await harness.open("one");
    const firstConversation = await first.conversations.createConversation({ sessionId: "same" });
    const secondConversation = await second.conversations.createConversation({ sessionId: "other" });
    await first.summaries.insertSummary({
      summaryId: "shared-summary",
      conversationId: firstConversation.conversationId,
      kind: "leaf",
      content: "first project",
      tokenCount: 2,
    });
    await second.summaries.insertSummary({
      summaryId: "shared-summary",
      conversationId: secondConversation.conversationId,
      kind: "leaf",
      content: "second project",
      tokenCount: 2,
    });
    await first.largeFiles.insertLargeFile({
      fileId: "shared-file",
      conversationId: firstConversation.conversationId,
      storageUri: "local:first",
    });
    await second.largeFiles.insertLargeFile({
      fileId: "shared-file",
      conversationId: secondConversation.conversationId,
      storageUri: "local:second",
    });
    expect((await first.summaries.getSummary("shared-summary"))?.content).toBe("first project");
    expect((await second.summaries.getSummary("shared-summary"))?.content).toBe("second project");
    expect((await first.largeFiles.getLargeFile("shared-file"))?.storageUri).toBe("local:first");
    expect((await second.largeFiles.getLargeFile("shared-file"))?.storageUri).toBe("local:second");
    expect(await second.conversations.getConversationBySessionId("same")).toBeNull();
    expect(await harness.factory.health()).toMatchObject({ status: "healthy", backend: harness.factory.backend });
    expect(await first.health()).toMatchObject({ status: "healthy", projectId: first.projectId });
    const closeA = first.close();
    const closeB = first.close();
    expect(closeA).toBe(closeB);
    await closeA;
    expect(await first.health()).toMatchObject({ status: "closed" });
    await expect(first.conversations.listConversations()).rejects.toMatchObject({ code: "STORAGE_CLOSED" });
    expect(await firstAgain.conversations.getConversationBySessionId("same")).not.toBeNull();
    await firstAgain.close();
    await second.close();
    const factoryCloseA = harness.factory.close();
    const factoryCloseB = harness.factory.close();
    expect(factoryCloseA).toBe(factoryCloseB);
    await factoryCloseA;
    expect(await harness.factory.health()).toMatchObject({ status: "closed" });
    await expect(harness.open("three")).rejects.toBeInstanceOf(StorageOperationError);
  });
}
