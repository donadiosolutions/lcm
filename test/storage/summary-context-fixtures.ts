import type {
  CreateLargeFileInput,
  CreateSummaryInput,
} from "../../src/store/summary-store.js";

export interface SummaryContextConformanceFixtures {
  readonly primarySessionId: string;
  readonly secondarySessionId: string;
  readonly messages: readonly [
    { readonly role: "user"; readonly content: string; readonly tokenCount: number },
    { readonly role: "assistant"; readonly content: string; readonly tokenCount: number },
    { readonly role: "tool"; readonly content: string; readonly tokenCount: number },
    { readonly role: "user"; readonly content: string; readonly tokenCount: number },
  ];
  readonly summaries: {
    readonly root: Omit<CreateSummaryInput, "conversationId">;
    readonly branchA: Omit<CreateSummaryInput, "conversationId">;
    readonly branchB: Omit<CreateSummaryInput, "conversationId">;
    readonly branchC: Omit<CreateSummaryInput, "conversationId">;
    readonly branchD: Omit<CreateSummaryInput, "conversationId">;
    readonly deepOne: Omit<CreateSummaryInput, "conversationId">;
    readonly deepTwo: Omit<CreateSummaryInput, "conversationId">;
    readonly sharedLeaf: Omit<CreateSummaryInput, "conversationId">;
    readonly diamondLayerOneLeft: Omit<CreateSummaryInput, "conversationId">;
    readonly diamondLayerOneRight: Omit<CreateSummaryInput, "conversationId">;
    readonly diamondLayerTwoLeft: Omit<CreateSummaryInput, "conversationId">;
    readonly diamondLayerTwoRight: Omit<CreateSummaryInput, "conversationId">;
    readonly diamondLeaf: Omit<CreateSummaryInput, "conversationId">;
    readonly replacement: Omit<CreateSummaryInput, "conversationId">;
    readonly secondary: Omit<CreateSummaryInput, "conversationId">;
  };
  readonly largeFiles: {
    readonly complete: Omit<CreateLargeFileInput, "conversationId">;
    readonly sparse: Omit<CreateLargeFileInput, "conversationId">;
    readonly secondary: Omit<CreateLargeFileInput, "conversationId">;
  };
}

/**
 * Shared values deliberately exercise IDs as opaque text. In particular,
 * summary file IDs are unresolved metadata: duplicates and caller order are
 * meaningful and must survive round trips without a large_files lookup.
 */
export function createSummaryContextConformanceFixtures(
  namespace = "summary-context-conformance",
): SummaryContextConformanceFixtures {
  const summaryId = (suffix: string): string => `${namespace}:summary:${suffix}`;
  const fileId = (suffix: string): string => `${namespace}:file:${suffix}`;
  const repeatedOpaqueFileIds = [
    `${namespace}:unresolved:alpha?revision=7`,
    "  opaque file id with surrounding whitespace  ",
    `${namespace}:unresolved:alpha?revision=7`,
    `${namespace}:unicode:資料/δ`,
  ];

  return {
    primarySessionId: `${namespace}:session:primary`,
    secondarySessionId: `${namespace}:session:secondary`,
    messages: [
      { role: "user", content: `${namespace} message zero`, tokenCount: 2 },
      { role: "assistant", content: `${namespace} message one`, tokenCount: 3 },
      { role: "tool", content: `${namespace} message two`, tokenCount: 5 },
      { role: "user", content: `${namespace} message three`, tokenCount: 7 },
    ],
    summaries: {
      root: {
        summaryId: summaryId("root"),
        kind: "condensed",
        depth: 4,
        content: `${namespace} root`,
        tokenCount: 19,
        fileIds: repeatedOpaqueFileIds,
        earliestAt: new Date("2026-01-02T03:04:05.000Z"),
        latestAt: new Date("2026-01-02T04:05:06.000Z"),
        descendantCount: 7,
        descendantTokenCount: 71,
        sourceMessageTokenCount: 17,
      },
      branchA: {
        summaryId: summaryId("branch-a"),
        kind: "condensed",
        depth: 3,
        content: `${namespace} branch A`,
        tokenCount: 11,
      },
      branchB: {
        summaryId: summaryId("branch-b"),
        kind: "condensed",
        depth: 3,
        content: `${namespace} branch B`,
        tokenCount: 13,
      },
      branchC: {
        summaryId: summaryId("branch-c"),
        kind: "leaf",
        depth: 0,
        content: `${namespace} branch C`,
        tokenCount: 17,
      },
      branchD: {
        summaryId: summaryId("branch-d"),
        kind: "leaf",
        depth: 0,
        content: `${namespace} branch D`,
        tokenCount: 23,
      },
      deepOne: {
        summaryId: summaryId("deep-one"),
        kind: "condensed",
        depth: 2,
        content: `${namespace} deep one`,
        tokenCount: 29,
      },
      deepTwo: {
        summaryId: summaryId("deep-two"),
        kind: "condensed",
        depth: 1,
        content: `${namespace} deep two`,
        tokenCount: 31,
      },
      sharedLeaf: {
        summaryId: summaryId("shared-leaf"),
        kind: "leaf",
        depth: 0,
        content: `${namespace} shared leaf`,
        tokenCount: 37,
      },
      diamondLayerOneLeft: {
        summaryId: summaryId("diamond-layer-1-left"),
        kind: "condensed",
        depth: 3,
        content: `${namespace} diamond layer one left`,
        tokenCount: 38,
      },
      diamondLayerOneRight: {
        summaryId: summaryId("diamond-layer-1-right"),
        kind: "condensed",
        depth: 3,
        content: `${namespace} diamond layer one right`,
        tokenCount: 39,
      },
      diamondLayerTwoLeft: {
        summaryId: summaryId("diamond-layer-2-left"),
        kind: "condensed",
        depth: 2,
        content: `${namespace} diamond layer two left`,
        tokenCount: 40,
      },
      diamondLayerTwoRight: {
        summaryId: summaryId("diamond-layer-2-right"),
        kind: "condensed",
        depth: 2,
        content: `${namespace} diamond layer two right`,
        tokenCount: 41,
      },
      diamondLeaf: {
        summaryId: summaryId("diamond-leaf"),
        kind: "leaf",
        depth: 0,
        content: `${namespace} diamond leaf`,
        tokenCount: 42,
      },
      replacement: {
        summaryId: summaryId("replacement"),
        kind: "condensed",
        depth: 6,
        content: `${namespace} context replacement`,
        tokenCount: 41,
      },
      secondary: {
        summaryId: summaryId("secondary"),
        kind: "leaf",
        depth: 0,
        content: `${namespace} secondary conversation`,
        tokenCount: 43,
      },
    },
    largeFiles: {
      complete: {
        fileId: fileId("complete"),
        fileName: "  quarterly report (final).資料  ",
        mimeType: "application/x-lcm-opaque+json; version=7",
        byteSize: 9_007_199_254_740_000,
        storageUri: `lcm+opaque://${namespace}/complete?signature=%2F%2B%3D`,
        explorationSummary: "Line one.\nLine two with unicode δ and preserved spacing.  ",
      },
      sparse: {
        fileId: fileId("sparse"),
        storageUri: `file:///tmp/${namespace}/sparse`,
      },
      secondary: {
        fileId: fileId("secondary"),
        fileName: "secondary.bin",
        mimeType: "application/octet-stream",
        byteSize: 0,
        storageUri: `s3://bucket/${namespace}/secondary`,
        explorationSummary: "",
      },
    },
  };
}
