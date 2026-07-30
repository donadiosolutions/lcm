import { expect } from "vitest";
import type { LexicalSearchRepository } from "../../src/storage/contracts.js";

export interface LexicalSearchConformanceFixtures {
  readonly primaryConversationId: number;
  readonly secondaryConversationId: number;
  readonly messageIds: {
    readonly accented: number;
    readonly regex: number;
    readonly isolated: number;
  };
  readonly summaryIds: {
    readonly accented: string;
    readonly regex: string;
    readonly isolated: string;
  };
  readonly memoryIds: {
    readonly content: string;
    readonly tagOnly: string;
    readonly isolated: string;
  };
  readonly sourceProjectId: string;
  readonly isolatedSourceProjectId: string;
  readonly searchTimestamp: Date;
}

function requireFixtures(
  fixtures: LexicalSearchConformanceFixtures | undefined
): LexicalSearchConformanceFixtures {
  if (fixtures === undefined) {
    throw new TypeError("lexical-search conformance requires seeded fixtures");
  }
  return fixtures;
}

function ids<T>(
  rows: readonly T[],
  identify: (row: T) => string | number
): Array<string | number> {
  return rows.map(identify);
}

function expectBoundedSnippets(
  rows: readonly { readonly snippet: string }[]
): void {
  for (const row of rows) {
    expect(row.snippet.length).toBeLessThanOrEqual(512);
    expect(row.snippet).not.toMatch(/<\/?(?:b|mark)>/iu);
  }
}

/**
 * Golden valid-input contract shared by SQLite and PostgreSQL. Backend-specific
 * timeout, SQL injection, malformed-row, and planner assertions stay in their
 * adapter suites so this seam compares only observable lexical behavior.
 */
export async function exerciseLexicalSearchRepositoryConformance(
  repository: LexicalSearchRepository,
  prepared?: LexicalSearchConformanceFixtures
): Promise<void> {
  const fixtures = requireFixtures(prepared);
  const {
    primaryConversationId,
    secondaryConversationId,
    messageIds,
    summaryIds,
    memoryIds,
    sourceProjectId,
    isolatedSourceProjectId,
    searchTimestamp,
  } = fixtures;

  const messages = await repository.searchMessages({
    query: "needle",
    mode: "full_text",
    limit: 10,
  });
  const repeatedMessages = await repository.searchMessages({
    query: "needle",
    mode: "full_text",
    limit: 10,
  });
  expect(ids(repeatedMessages, (row) => row.messageId)).toEqual(
    ids(messages, (row) => row.messageId)
  );
  expect(new Set(ids(messages, (row) => row.messageId))).toEqual(
    new Set([messageIds.accented, messageIds.regex, messageIds.isolated])
  );
  expectBoundedSnippets(messages);
  expect(
    await repository.searchMessages({
      query: "needle",
      mode: "full_text",
      conversationId: primaryConversationId,
      limit: 10,
    })
  ).toHaveLength(2);
  expect(
    await repository.searchMessages({
      query: "needle",
      mode: "full_text",
      conversationId: secondaryConversationId,
      limit: 10,
    })
  ).toMatchObject([{ messageId: messageIds.isolated }]);
  expect(
    await repository.searchMessages({
      query: "(needle)-[0-9]+",
      mode: "regex",
      limit: 10,
    })
  ).toMatchObject([
    {
      messageId: messageIds.regex,
      snippet: "needle-2046",
    },
  ]);
  expect(
    await repository.searchMessages({
      query: "cafe",
      mode: "full_text",
      limit: 10,
    })
  ).toMatchObject([{ messageId: messageIds.accented }]);
  expect(
    await repository.searchMessages({
      query: "βeta",
      mode: "full_text",
      limit: 10,
    })
  ).toMatchObject([{ messageId: messageIds.accented }]);
  expect(
    await repository.searchMessages({
      query: "foo_bar",
      mode: "full_text",
      limit: 10,
    })
  ).toMatchObject([{ messageId: messageIds.accented }]);
  expect(
    await repository.searchMessages({
      query: "needle",
      mode: "full_text",
      since: new Date(searchTimestamp.getTime() + 86_400_000),
      limit: 10,
    })
  ).toEqual([]);
  expect(
    await repository.searchMessages({
      query: "needle",
      mode: "full_text",
      before: new Date(searchTimestamp.getTime() - 86_400_000),
      limit: 10,
    })
  ).toEqual([]);
  const oneMessage = await repository.searchMessages({
    query: "needle",
    mode: "full_text",
    limit: 1,
  });
  expect(oneMessage).toHaveLength(1);
  expect(
    await repository.searchMessages({
      query: "",
      mode: "full_text",
    })
  ).toEqual([]);
  expect(
    await repository.searchMessages({
      query: "\u20dd",
      mode: "full_text",
    })
  ).toEqual([]);
  await expect(
    repository.searchMessages({
      query: "(a+)+$",
      mode: "regex",
    })
  ).rejects.toBeInstanceOf(Error);

  const summaries = await repository.searchSummaries({
    query: "needle",
    mode: "full_text",
    limit: 10,
  });
  const repeatedSummaries = await repository.searchSummaries({
    query: "needle",
    mode: "full_text",
    limit: 10,
  });
  expect(ids(repeatedSummaries, (row) => row.summaryId)).toEqual(
    ids(summaries, (row) => row.summaryId)
  );
  expect(new Set(ids(summaries, (row) => row.summaryId))).toEqual(
    new Set([summaryIds.accented, summaryIds.regex, summaryIds.isolated])
  );
  expectBoundedSnippets(summaries);
  expect(
    await repository.searchSummaries({
      query: "needle",
      mode: "full_text",
      conversationId: primaryConversationId,
      limit: 10,
    })
  ).toHaveLength(2);
  expect(
    await repository.searchSummaries({
      query: "(summary)-[0-9]+",
      mode: "regex",
      limit: 10,
    })
  ).toMatchObject([
    {
      summaryId: summaryIds.regex,
      snippet: "summary-2047",
    },
  ]);
  expect(
    await repository.searchSummaries({
      query: "cafe",
      mode: "full_text",
      limit: 10,
    })
  ).toMatchObject([{ summaryId: summaryIds.accented }]);
  expect(
    await repository.searchSummaries({
      query: "needle",
      mode: "full_text",
      since: new Date(searchTimestamp.getTime() + 86_400_000),
      limit: 10,
    })
  ).toEqual([]);
  expect(
    await repository.searchSummaries({
      query: "needle",
      mode: "full_text",
      before: new Date(searchTimestamp.getTime() - 86_400_000),
      limit: 10,
    })
  ).toEqual([]);
  expect(
    await repository.searchSummaries({
      query: "needle",
      mode: "full_text",
      limit: 1,
    })
  ).toHaveLength(1);
  expect(
    await repository.searchSummaries({
      query: "   ",
      mode: "full_text",
    })
  ).toEqual([]);
  expect(
    await repository.searchSummaries({
      query: "\u0301\u20de",
      mode: "full_text",
    })
  ).toEqual([]);
  await expect(
    repository.searchSummaries({
      query: "[",
      mode: "regex",
    })
  ).rejects.toBeInstanceOf(Error);

  const promoted = await repository.searchPromoted("primarydurable", 10);
  expect(promoted).toMatchObject([
    {
      id: memoryIds.content,
      projectId: sourceProjectId,
    },
  ]);
  const durable = await repository.searchPromoted("durable", 10);
  const repeatedDurable = await repository.searchPromoted("durable", 10);
  expect(ids(repeatedDurable, (row) => row.id)).toEqual(
    ids(durable, (row) => row.id)
  );
  expect(await repository.searchPromoted("tagonly", 10)).toMatchObject([
    {
      id: memoryIds.tagOnly,
      tags: expect.arrayContaining(["tagonly", "required"]),
    },
  ]);
  expect(
    await repository.searchPromoted("tagonly", 10, ["required"])
  ).toMatchObject([{ id: memoryIds.tagOnly }]);
  expect(await repository.searchPromoted("tagonly", 10, ["missing"])).toEqual(
    []
  );
  expect(
    await repository.searchPromoted(
      "primarydurable",
      10,
      undefined,
      sourceProjectId
    )
  ).toMatchObject([{ id: memoryIds.content }]);
  expect(
    await repository.searchPromoted(
      "isolateddurable",
      10,
      undefined,
      isolatedSourceProjectId
    )
  ).toMatchObject([{ id: memoryIds.isolated }]);
  expect(await repository.searchPromoted("durable", 1)).toHaveLength(1);
  expect(await repository.searchPromoted("", 10)).toEqual([]);
  expect(await repository.searchPromoted("\u20e0\u0362", 10)).toEqual([]);
  expect(
    (await repository.searchPromoted("_%; DROP TABLE memories; --", 10)).length
  ).toBeLessThanOrEqual(2);

  expect(
    await repository.searchMessages({
      query: "needle",
      mode: "full_text",
      limit: 10,
    })
  ).toHaveLength(3);
  expect(
    await repository.searchSummaries({
      query: "needle",
      mode: "full_text",
      limit: 10,
    })
  ).toHaveLength(3);
  expect(durable).toHaveLength(2);
}
