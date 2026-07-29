import { expect } from "vitest";
import type {
  ContextRepository,
  ConversationRepository,
  LargeFileRepository,
  SummaryRepository,
} from "../../src/storage/contracts.js";
import type {
  ContextItemRecord,
  LargeFileRecord,
  SummaryRecord,
  SummarySubtreeNodeRecord,
} from "../../src/store/summary-store.js";
import {
  createSummaryContextConformanceFixtures,
  type SummaryContextConformanceFixtures,
} from "./summary-context-fixtures.js";

export interface SummaryRepositoryConformanceInput {
  readonly fixtures: SummaryContextConformanceFixtures;
  readonly primaryConversationId: number;
  readonly secondaryConversationId: number;
  readonly messageIds: readonly [number, number, number, number];
}

export interface SummaryRepositoryConformanceResult {
  readonly inserted: Readonly<Record<
    keyof SummaryContextConformanceFixtures["summaries"],
    SummaryRecord
  >>;
  readonly subtree: readonly SummarySubtreeNodeRecord[];
}

export interface ContextRepositoryConformanceInput {
  readonly fixtures: SummaryContextConformanceFixtures;
  readonly primaryConversationId: number;
  readonly secondaryConversationId: number;
  readonly messageIds: readonly [number, number, number, number];
}

export interface LargeFileRepositoryConformanceInput {
  readonly fixtures: SummaryContextConformanceFixtures;
  readonly primaryConversationId: number;
  readonly secondaryConversationId: number;
}

export interface SummaryContextRepositoryConformanceResult {
  readonly primaryConversationId: number;
  readonly secondaryConversationId: number;
  readonly messageIds: readonly [number, number, number, number];
  readonly summaries: SummaryRepositoryConformanceResult;
  readonly context: readonly ContextItemRecord[];
  readonly largeFiles: readonly LargeFileRecord[];
}

export interface SummaryContextConformanceRepositories {
  readonly conversations: ConversationRepository;
  readonly summaries: SummaryRepository;
  readonly context: ContextRepository;
  readonly largeFiles: LargeFileRepository;
}

function requireConformanceInput<T>(
  input: T | undefined,
  domain: string,
): T {
  if (input === undefined) {
    throw new TypeError(`${domain} conformance requires prepared conversation fixtures`);
  }
  return input;
}

function ids(rows: readonly SummaryRecord[]): string[] {
  return rows.map((row) => row.summaryId);
}

function expectStableMembership(
  first: readonly SummaryRecord[],
  second: readonly SummaryRecord[],
  expectedIds: readonly string[],
): void {
  expect(ids(second)).toEqual(ids(first));
  expect(new Set(ids(first))).toEqual(new Set(expectedIds));
}

/**
 * Exercise the backend-neutral summary repository against prepared
 * conversation/message rows. The optional fixture parameter keeps this
 * function assignable to the manifest's domain seam; real conformance callers
 * must supply it, normally through exerciseSummaryContextRepositoryConformance.
 */
export async function exerciseSummaryRepositoryConformance(
  repository: SummaryRepository,
  prepared?: SummaryRepositoryConformanceInput,
): Promise<SummaryRepositoryConformanceResult> {
  const {
    fixtures,
    primaryConversationId,
    secondaryConversationId,
    messageIds,
  } = requireConformanceInput(prepared, "summary");
  const { summaries } = fixtures;
  const inserted = {
    root: await repository.insertSummary({
      ...summaries.root,
      conversationId: primaryConversationId,
    }),
    branchA: await repository.insertSummary({
      ...summaries.branchA,
      conversationId: primaryConversationId,
    }),
    branchB: await repository.insertSummary({
      ...summaries.branchB,
      conversationId: primaryConversationId,
    }),
    branchC: await repository.insertSummary({
      ...summaries.branchC,
      conversationId: primaryConversationId,
    }),
    branchD: await repository.insertSummary({
      ...summaries.branchD,
      conversationId: primaryConversationId,
    }),
    deepOne: await repository.insertSummary({
      ...summaries.deepOne,
      conversationId: primaryConversationId,
    }),
    deepTwo: await repository.insertSummary({
      ...summaries.deepTwo,
      conversationId: primaryConversationId,
    }),
    sharedLeaf: await repository.insertSummary({
      ...summaries.sharedLeaf,
      conversationId: primaryConversationId,
    }),
    diamondLayerOneLeft: await repository.insertSummary({
      ...summaries.diamondLayerOneLeft,
      conversationId: primaryConversationId,
    }),
    diamondLayerOneRight: await repository.insertSummary({
      ...summaries.diamondLayerOneRight,
      conversationId: primaryConversationId,
    }),
    diamondLayerTwoLeft: await repository.insertSummary({
      ...summaries.diamondLayerTwoLeft,
      conversationId: primaryConversationId,
    }),
    diamondLayerTwoRight: await repository.insertSummary({
      ...summaries.diamondLayerTwoRight,
      conversationId: primaryConversationId,
    }),
    diamondLeaf: await repository.insertSummary({
      ...summaries.diamondLeaf,
      conversationId: primaryConversationId,
    }),
    replacement: await repository.insertSummary({
      ...summaries.replacement,
      conversationId: primaryConversationId,
    }),
    secondary: await repository.insertSummary({
      ...summaries.secondary,
      conversationId: secondaryConversationId,
    }),
  } satisfies Record<keyof typeof summaries, SummaryRecord>;

  expect(inserted.root).toMatchObject({
    ...summaries.root,
    conversationId: primaryConversationId,
  });
  expect(inserted.root.fileIds).toEqual(summaries.root.fileIds);
  expect(inserted.root.createdAt).toBeInstanceOf(Date);
  expect(await repository.getSummary(summaries.root.summaryId)).toEqual(inserted.root);
  expect(await repository.getSummary(`${summaries.root.summaryId}:missing`)).toBeNull();

  const primaryIds = [
    summaries.root.summaryId,
    summaries.branchA.summaryId,
    summaries.branchB.summaryId,
    summaries.branchC.summaryId,
    summaries.branchD.summaryId,
    summaries.deepOne.summaryId,
    summaries.deepTwo.summaryId,
    summaries.sharedLeaf.summaryId,
    summaries.diamondLayerOneLeft.summaryId,
    summaries.diamondLayerOneRight.summaryId,
    summaries.diamondLayerTwoLeft.summaryId,
    summaries.diamondLayerTwoRight.summaryId,
    summaries.diamondLeaf.summaryId,
    summaries.replacement.summaryId,
  ];
  const primaryRows = await repository.getSummariesByConversation(primaryConversationId);
  expectStableMembership(
    primaryRows,
    await repository.getSummariesByConversation(primaryConversationId),
    primaryIds,
  );
  expect(ids(await repository.getSummariesByConversation(secondaryConversationId)))
    .toEqual([summaries.secondary.summaryId]);

  const recent = await repository.listRecentSummaries(4);
  expect(ids(await repository.listRecentSummaries(4))).toEqual(ids(recent));
  expect(recent).toHaveLength(4);
  expect(await repository.listRecentSummaries(0)).toEqual([]);

  const sessionRows = await repository.listRecentSummariesForSession(
    fixtures.primarySessionId,
    primaryIds.length + 1,
  );
  expectStableMembership(
    sessionRows,
    await repository.listRecentSummariesForSession(
      fixtures.primarySessionId,
      primaryIds.length + 1,
    ),
    primaryIds,
  );
  expect(ids(await repository.listRecentSummariesForSession(
    fixtures.secondarySessionId,
    2,
  ))).toEqual([summaries.secondary.summaryId]);
  expect(await repository.listRecentSummariesForSession(
    `${fixtures.primarySessionId}:missing`,
    2,
  )).toEqual([]);

  await repository.linkSummaryToMessages(summaries.root.summaryId, [
    messageIds[2],
    messageIds[0],
    messageIds[1],
  ]);
  await repository.linkSummaryToMessages(summaries.root.summaryId, []);
  expect(await repository.getSummaryMessages(summaries.root.summaryId)).toEqual([
    messageIds[2],
    messageIds[0],
    messageIds[1],
  ]);
  expect(await repository.getSummaryMessages(`${summaries.root.summaryId}:missing`))
    .toEqual([]);

  await repository.linkSummaryToParents(
    summaries.branchA.summaryId,
    [summaries.root.summaryId],
  );
  await repository.linkSummaryToParents(
    summaries.branchB.summaryId,
    [summaries.root.summaryId],
  );
  await repository.linkSummaryToParents(
    summaries.branchC.summaryId,
    [summaries.root.summaryId],
  );
  await repository.linkSummaryToParents(
    summaries.branchD.summaryId,
    [summaries.root.summaryId],
  );
  await repository.linkSummaryToParents(
    summaries.deepOne.summaryId,
    [summaries.branchA.summaryId],
  );
  await repository.linkSummaryToParents(
    summaries.deepTwo.summaryId,
    [summaries.deepOne.summaryId],
  );
  await repository.linkSummaryToParents(summaries.sharedLeaf.summaryId, [
    summaries.branchB.summaryId,
    summaries.deepTwo.summaryId,
  ]);
  await repository.linkSummaryToParents(
    summaries.diamondLayerOneLeft.summaryId,
    [summaries.root.summaryId],
  );
  await repository.linkSummaryToParents(
    summaries.diamondLayerOneRight.summaryId,
    [summaries.root.summaryId],
  );
  await repository.linkSummaryToParents(
    summaries.diamondLayerTwoLeft.summaryId,
    [
      summaries.diamondLayerOneLeft.summaryId,
      summaries.diamondLayerOneRight.summaryId,
    ],
  );
  await repository.linkSummaryToParents(
    summaries.diamondLayerTwoRight.summaryId,
    [
      summaries.diamondLayerOneLeft.summaryId,
      summaries.diamondLayerOneRight.summaryId,
    ],
  );
  await repository.linkSummaryToParents(summaries.diamondLeaf.summaryId, [
    summaries.diamondLayerTwoLeft.summaryId,
    summaries.diamondLayerTwoRight.summaryId,
  ]);
  await repository.linkSummaryToParents(summaries.root.summaryId, []);

  expect(ids(await repository.getSummaryParents(summaries.sharedLeaf.summaryId)))
    .toEqual([summaries.branchB.summaryId, summaries.deepTwo.summaryId]);
  expect(ids(await repository.getSummaryChildren(summaries.root.summaryId)))
    .toEqual([
      summaries.branchA.summaryId,
      summaries.branchB.summaryId,
      summaries.branchC.summaryId,
      summaries.branchD.summaryId,
      summaries.diamondLayerOneLeft.summaryId,
      summaries.diamondLayerOneRight.summaryId,
    ]);
  expect(await repository.getSummaryChildren(`${summaries.root.summaryId}:missing`))
    .toEqual([]);
  expect(await repository.getSummaryParents(summaries.root.summaryId)).toEqual([]);

  const subtree = await repository.getSummarySubtree(summaries.root.summaryId);
  expect(await repository.getSummarySubtree(summaries.root.summaryId)).toEqual(subtree);
  expect(subtree[0]).toMatchObject({
    summaryId: summaries.root.summaryId,
    depthFromRoot: 0,
    parentSummaryId: null,
    path: "",
    childCount: 6,
  });
  expect(new Set(subtree.map((row) => row.summaryId))).toEqual(new Set([
    summaries.root.summaryId,
    summaries.branchA.summaryId,
    summaries.branchB.summaryId,
    summaries.branchC.summaryId,
    summaries.branchD.summaryId,
    summaries.deepOne.summaryId,
    summaries.deepTwo.summaryId,
    summaries.sharedLeaf.summaryId,
    summaries.diamondLayerOneLeft.summaryId,
    summaries.diamondLayerOneRight.summaryId,
    summaries.diamondLayerTwoLeft.summaryId,
    summaries.diamondLayerTwoRight.summaryId,
    summaries.diamondLeaf.summaryId,
  ]));
  expect(subtree).toHaveLength(13);
  const sharedLeaf = subtree.find(
    (row) => row.summaryId === summaries.sharedLeaf.summaryId,
  );
  expect(sharedLeaf).toMatchObject({
    depthFromRoot: 2,
    parentSummaryId: summaries.branchB.summaryId,
    childCount: 0,
  });
  const diamondLeaf = subtree.find(
    (row) => row.summaryId === summaries.diamondLeaf.summaryId,
  );
  expect(diamondLeaf).toMatchObject({
    depthFromRoot: 3,
    parentSummaryId: summaries.diamondLayerTwoLeft.summaryId,
    path: "0000.0000.0000",
    childCount: 0,
  });
  expect(await repository.getSummarySubtree(`${summaries.root.summaryId}:missing`))
    .toEqual([]);

  return { inserted, subtree };
}

export async function exerciseContextRepositoryConformance(
  repository: ContextRepository,
  prepared?: ContextRepositoryConformanceInput,
): Promise<readonly ContextItemRecord[]> {
  const {
    fixtures,
    primaryConversationId,
    secondaryConversationId,
    messageIds,
  } = requireConformanceInput(prepared, "context");
  const { summaries } = fixtures;

  expect(await repository.getContextItems(primaryConversationId)).toEqual([]);
  expect(await repository.getContextTokenCount(primaryConversationId)).toBe(0);
  expect(await repository.getDistinctDepthsInContext(primaryConversationId)).toEqual([]);

  await repository.appendContextMessage(primaryConversationId, messageIds[0]);
  await repository.appendContextMessages(primaryConversationId, [
    messageIds[1],
    messageIds[2],
  ]);
  await repository.appendContextMessages(primaryConversationId, []);
  await repository.appendContextSummary(primaryConversationId, summaries.root.summaryId);

  const beforeReplacement = await repository.getContextItems(primaryConversationId);
  expect(beforeReplacement.map(({ ordinal, itemType, messageId, summaryId }) => ({
    ordinal,
    itemType,
    messageId,
    summaryId,
  }))).toEqual([
    { ordinal: 0, itemType: "message", messageId: messageIds[0], summaryId: null },
    { ordinal: 1, itemType: "message", messageId: messageIds[1], summaryId: null },
    { ordinal: 2, itemType: "message", messageId: messageIds[2], summaryId: null },
    {
      ordinal: 3,
      itemType: "summary",
      messageId: null,
      summaryId: summaries.root.summaryId,
    },
  ]);
  expect(beforeReplacement.every((row) => row.createdAt instanceof Date)).toBe(true);
  expect(await repository.getContextTokenCount(primaryConversationId)).toBe(29);
  expect(await repository.getDistinctDepthsInContext(primaryConversationId)).toEqual([4]);
  expect(await repository.getDistinctDepthsInContext(
    primaryConversationId,
    { maxOrdinalExclusive: 3 },
  )).toEqual([]);
  expect(await repository.getDistinctDepthsInContext(
    primaryConversationId,
    { maxOrdinalExclusive: -0.25 },
  )).toEqual([]);
  expect(await repository.getDistinctDepthsInContext(
    primaryConversationId,
    { maxOrdinalExclusive: 1e100 },
  )).toEqual([4]);

  await repository.replaceContextRangeWithSummary({
    conversationId: primaryConversationId,
    startOrdinal: 1,
    endOrdinal: 2,
    summaryId: summaries.replacement.summaryId,
  });
  await repository.appendContextMessage(primaryConversationId, messageIds[3]);

  const afterReplacement = await repository.getContextItems(primaryConversationId);
  expect(afterReplacement.map(({ ordinal, itemType, messageId, summaryId }) => ({
    ordinal,
    itemType,
    messageId,
    summaryId,
  }))).toEqual([
    { ordinal: 0, itemType: "message", messageId: messageIds[0], summaryId: null },
    {
      ordinal: 1,
      itemType: "summary",
      messageId: null,
      summaryId: summaries.replacement.summaryId,
    },
    {
      ordinal: 2,
      itemType: "summary",
      messageId: null,
      summaryId: summaries.root.summaryId,
    },
    { ordinal: 3, itemType: "message", messageId: messageIds[3], summaryId: null },
  ]);
  expect(await repository.getContextTokenCount(primaryConversationId)).toBe(69);
  expect(await repository.getDistinctDepthsInContext(primaryConversationId))
    .toEqual([4, 6]);
  expect(await repository.getDistinctDepthsInContext(
    primaryConversationId,
    { maxOrdinalExclusive: 2 },
  )).toEqual([6]);

  expect(await repository.getContextItems(secondaryConversationId)).toEqual([]);
  expect(await repository.getContextTokenCount(secondaryConversationId)).toBe(0);
  expect(await repository.getDistinctDepthsInContext(secondaryConversationId)).toEqual([]);

  return afterReplacement;
}

export async function exerciseLargeFileRepositoryConformance(
  repository: LargeFileRepository,
  prepared?: LargeFileRepositoryConformanceInput,
): Promise<readonly LargeFileRecord[]> {
  const {
    fixtures,
    primaryConversationId,
    secondaryConversationId,
  } = requireConformanceInput(prepared, "large-file");
  const { largeFiles } = fixtures;

  const complete = await repository.insertLargeFile({
    ...largeFiles.complete,
    conversationId: primaryConversationId,
  });
  const sparse = await repository.insertLargeFile({
    ...largeFiles.sparse,
    conversationId: primaryConversationId,
  });
  const secondary = await repository.insertLargeFile({
    ...largeFiles.secondary,
    conversationId: secondaryConversationId,
  });

  expect(complete).toMatchObject({
    ...largeFiles.complete,
    conversationId: primaryConversationId,
  });
  expect(complete.createdAt).toBeInstanceOf(Date);
  expect(sparse).toMatchObject({
    ...largeFiles.sparse,
    conversationId: primaryConversationId,
    fileName: null,
    mimeType: null,
    byteSize: null,
    explorationSummary: null,
  });
  expect(secondary).toMatchObject({
    ...largeFiles.secondary,
    conversationId: secondaryConversationId,
  });
  expect(await repository.getLargeFile(largeFiles.complete.fileId)).toEqual(complete);
  expect(await repository.getLargeFile(`${largeFiles.complete.fileId}:missing`)).toBeNull();

  const primaryFiles = await repository.getLargeFilesByConversation(primaryConversationId);
  expect(await repository.getLargeFilesByConversation(primaryConversationId))
    .toEqual(primaryFiles);
  expect(primaryFiles).toEqual([complete, sparse]);
  expect(await repository.getLargeFilesByConversation(secondaryConversationId))
    .toEqual([secondary]);

  return primaryFiles;
}

/**
 * Seed the foreign-key prerequisites once, then exercise the three independently
 * exported summary/context/large-file repository contracts.
 */
export async function exerciseSummaryContextRepositoryConformance(
  repositories: SummaryContextConformanceRepositories,
  namespace?: string,
): Promise<SummaryContextRepositoryConformanceResult> {
  const fixtures = createSummaryContextConformanceFixtures(namespace);
  const primary = await repositories.conversations.createConversation({
    sessionId: fixtures.primarySessionId,
    title: "Summary context conformance primary",
  });
  const secondary = await repositories.conversations.createConversation({
    sessionId: fixtures.secondarySessionId,
    title: "Summary context conformance secondary",
  });
  const createdMessages = await repositories.conversations.createMessagesBulk(
    fixtures.messages.map((message, seq) => ({
      conversationId: primary.conversationId,
      seq,
      ...message,
    })),
  );
  expect(createdMessages).toHaveLength(4);
  const messageIds = createdMessages.map(
    (message) => message.messageId,
  ) as [number, number, number, number];
  const sharedInput = {
    fixtures,
    primaryConversationId: primary.conversationId,
    secondaryConversationId: secondary.conversationId,
    messageIds,
  };

  const summaries = await exerciseSummaryRepositoryConformance(
    repositories.summaries,
    sharedInput,
  );
  const context = await exerciseContextRepositoryConformance(
    repositories.context,
    sharedInput,
  );
  const largeFiles = await exerciseLargeFileRepositoryConformance(
    repositories.largeFiles,
    sharedInput,
  );

  return {
    primaryConversationId: primary.conversationId,
    secondaryConversationId: secondary.conversationId,
    messageIds,
    summaries,
    context,
    largeFiles,
  };
}
