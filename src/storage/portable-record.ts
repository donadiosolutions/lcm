import { createHash } from "node:crypto";

/** The versioned, backend-neutral portable record domains. */
export const PORTABLE_RECORD_DOMAIN_ORDER = Object.freeze([
  "machines",
  "project",
  "project-aliases",
  "conversations",
  "messages",
  "message-parts",
  "large-files",
  "summaries",
  "summary-file-links",
  "summary-message-links",
  "summary-parent-links",
  "context-items",
  "promoted-memories",
  "promoted-memory-tags",
  "recall-surfacings",
  "redaction-counters",
  "session-ingest",
  "session-instructions",
  "native-transcripts",
  "native-transcript-message-links",
  "native-transcript-checkpoints",
  "passive-events",
] as const);

export type PortableDomain = (typeof PORTABLE_RECORD_DOMAIN_ORDER)[number];
export type PortableNullableString = string | null;
declare const portableIntegerRange: unique symbol;
declare const portableTimestamp: unique symbol;

type PortableInteger<R extends string> = Readonly<{
  readonly $integer: string;
  readonly [portableIntegerRange]: R;
}>;

export type PortableSignedInt64 = PortableInteger<"signed-int64">;
export type PortableNonnegativeInt64 = PortableInteger<"nonnegative-int64">;
export type PortablePositiveInt4 = PortableInteger<"positive-int4">;
export type PortableNonnegativeInt4 = PortableInteger<"nonnegative-int4">;
export type PortableSignedSafeInteger = PortableInteger<"signed-safe-integer">;
export type PortableNonnegativeSafeInteger = PortableInteger<"nonnegative-safe-integer">;
export type PortableIntegerValue =
  | PortableSignedInt64
  | PortableNonnegativeInt64
  | PortablePositiveInt4
  | PortableNonnegativeInt4
  | PortableSignedSafeInteger
  | PortableNonnegativeSafeInteger;
export type PortableOrderScalar = string | PortableIntegerValue | null;
export type PortableTimestamp = string & { readonly [portableTimestamp]: "utc-six-digit" };
export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export const PORTABLE_LIMITS = Object.freeze({
  maxJsonDepth: 100,
  maxRecordBytes: 128 * 1024 * 1024,
  maxBatchRecords: 500,
  maxBatchBytes: 144 * 1024 * 1024,
  maxControlBytes: 1024 * 1024,
} as const);

export type PortableRawInteger = bigint | number | string;
export type PortableRawTimestamp = Date | string;

export type PortableRawConversationOrder = readonly [
  sessionId: string,
  title: string | null,
  bootstrappedAt: PortableRawTimestamp | null,
  createdAt: PortableRawTimestamp,
  updatedAt: PortableRawTimestamp,
  occurrenceOrdinal: PortableRawInteger,
];

export type PortableRawMessageOrder = readonly [
  ...conversation: PortableRawConversationOrder,
  seq: PortableRawInteger,
];

export type PortableRecordConstructionContextByDomain = Readonly<{
  machines: null;
  project: null;
  "project-aliases": Readonly<{ projectIdentity: PortableProjectIdentity }>;
  conversations: Readonly<{ projectIdentity: PortableProjectIdentity }>;
  messages: Readonly<{ conversationOrder: PortableRawConversationOrder }>;
  "message-parts": Readonly<{ messageOrder: PortableRawMessageOrder }>;
  "large-files": null;
  summaries: null;
  "summary-file-links": null;
  "summary-message-links": null;
  "summary-parent-links": null;
  "context-items": Readonly<{ conversationOrder: PortableRawConversationOrder }>;
  "promoted-memories": Readonly<{ projectIdentity: PortableProjectIdentity }>;
  "promoted-memory-tags": null;
  "recall-surfacings": Readonly<{ projectIdentity: PortableProjectIdentity }>;
  "redaction-counters": Readonly<{ projectIdentity: PortableProjectIdentity }>;
  "session-ingest": Readonly<{ projectIdentity: PortableProjectIdentity }>;
  "session-instructions": Readonly<{ projectIdentity: PortableProjectIdentity }>;
  "native-transcripts": Readonly<{
    projectIdentity: PortableProjectIdentity;
    canonicalPayloadBytes: number;
    canonicalMetadataBytes: number;
  }>;
  "native-transcript-message-links": null;
  "native-transcript-checkpoints": Readonly<{ projectIdentity: PortableProjectIdentity }>;
  "passive-events": Readonly<{ projectIdentity: PortableProjectIdentity }>;
}>;

export type PortableRecordConstructionContext<D extends PortableDomain = PortableDomain> =
  PortableRecordConstructionContextByDomain[D];

export type PortableRecordValueInputByDomain = Readonly<{
  machines: Readonly<{ identityKey: string; machineId: string | null }>;
  project: Readonly<{ identity: PortableProjectIdentity }>;
  "project-aliases": Readonly<{ machineIdentityKey: string; path: string; normalizedPath: string }>;
  conversations: Readonly<{
    conversationFingerprint: string;
    occurrenceOrdinal: PortableRawInteger;
    sessionId: string;
    createdAt: PortableRawTimestamp;
    title: string | null;
    bootstrappedAt: PortableRawTimestamp | null;
    updatedAt: PortableRawTimestamp;
  }>;
  messages: Readonly<{
    conversationIdentitySha256: string;
    seq: PortableRawInteger;
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tokenCount: PortableRawInteger;
    createdAt: PortableRawTimestamp;
  }>;
  "message-parts": Readonly<{
    messageIdentitySha256: string;
    partId: string;
    sessionId: string;
    partType: PortableRecordValueByDomain["message-parts"]["partType"];
    ordinal: PortableRawInteger;
    textContent: string | null;
    isIgnored: boolean | null;
    isSynthetic: boolean | null;
    toolCallId: string | null;
    toolName: string | null;
    toolStatus: string | null;
    toolInput: string | null;
    toolOutput: string | null;
    toolError: string | null;
    toolTitle: string | null;
    patchHash: string | null;
    patchFiles: string | null;
    fileMime: string | null;
    fileName: string | null;
    fileUrl: string | null;
    subtaskPrompt: string | null;
    subtaskDescription: string | null;
    subtaskAgent: string | null;
    stepReason: string | null;
    stepCost: number | null;
    stepTokensIn: PortableRawInteger | null;
    stepTokensOut: PortableRawInteger | null;
    snapshotHash: string | null;
    compactionAuto: boolean | null;
    metadata: string | null;
  }>;
  "large-files": Readonly<{
    fileId: string;
    conversationIdentitySha256: string;
    fileName: string | null;
    mimeType: string | null;
    byteSize: PortableRawInteger | null;
    storageUri: string;
    explorationSummary: string | null;
    createdAt: PortableRawTimestamp;
  }>;
  summaries: Readonly<{
    summaryId: string;
    conversationIdentitySha256: string;
    kind: "leaf" | "condensed";
    depth: PortableRawInteger;
    content: string;
    tokenCount: PortableRawInteger;
    earliestAt: PortableRawTimestamp | null;
    latestAt: PortableRawTimestamp | null;
    descendantCount: PortableRawInteger;
    descendantTokenCount: PortableRawInteger;
    sourceMessageTokenCount: PortableRawInteger;
    createdAt: PortableRawTimestamp;
  }>;
  "summary-file-links": Readonly<{ summaryId: string; ordinal: PortableRawInteger; fileId: string }>;
  "summary-message-links": Readonly<{ summaryId: string; ordinal: PortableRawInteger; messageIdentitySha256: string }>;
  "summary-parent-links": Readonly<{ summaryId: string; ordinal: PortableRawInteger; parentSummaryId: string }>;
  "context-items": Readonly<{
    conversationIdentitySha256: string;
    ordinal: PortableRawInteger;
    itemType: "message" | "summary";
    messageIdentitySha256: string | null;
    summaryId: string | null;
    createdAt: PortableRawTimestamp;
  }>;
  "promoted-memories": Readonly<{
    memoryId: string;
    content: string;
    metadata: JsonObject;
    sourceProjectId: string | null;
    sourceSummaryId: string | null;
    sessionId: string | null;
    depth: PortableRawInteger;
    confidence: number;
    createdAt: PortableRawTimestamp;
    archivedAt: PortableRawTimestamp | null;
  }>;
  "promoted-memory-tags": Readonly<{ memoryId: string; ordinal: PortableRawInteger; tag: string }>;
  "recall-surfacings": Readonly<{
    memoryId: string;
    sessionId: string | null;
    surfacedAt: PortableRawTimestamp;
    occurrenceOrdinal: PortableRawInteger;
  }>;
  "redaction-counters": Readonly<{ category: "built_in" | "global" | "project" | "gitleaks"; count: PortableRawInteger }>;
  "session-ingest": Readonly<{ sessionId: string; messageCount: PortableRawInteger; completedAt: PortableRawTimestamp }>;
  "session-instructions": Readonly<{
    machineIdentityKey: string;
    scopeHash: string;
    clientName: "claude" | "codex";
    sessionId: string;
    worktreePath: string;
    cwdPath: string;
    content: string;
    contentHash: string;
    updatedAt: PortableRawTimestamp;
  }>;
  "native-transcripts": Readonly<{
    machineIdentityKey: string;
    clientName: string;
    formatName: string;
    formatVersion: string;
    nativeSessionId: string;
    sourceLocator: string;
    sourceOrdinal: PortableRawInteger;
    observedAt: PortableRawTimestamp;
    ingestedAt: PortableRawTimestamp;
    scrubberVersion: string;
    contentSha256: string;
    ingestKey: string;
    nativePayload: JsonObject | readonly JsonValue[];
  }>;
  "native-transcript-message-links": Readonly<{
    machineIdentityKey: string;
    ingestKey: string;
    sourceOrdinal: PortableRawInteger;
    conversationIdentitySha256: string;
    messageIdentitySha256: string;
  }>;
  "native-transcript-checkpoints": Readonly<{
    machineIdentityKey: string;
    clientName: string;
    sourceLocator: string;
    revision: PortableRawInteger;
    lastSourceOrdinal: PortableRawInteger;
    importedCount: PortableRawInteger;
    skippedCount: PortableRawInteger;
    quarantinedCount: PortableRawInteger;
    checkpoint: JsonObject;
    updatedAt: PortableRawTimestamp;
  }>;
  "passive-events": Readonly<{
    machineIdentityKey: string;
    eventId: string;
    eventVersion: PortableRawInteger;
    machineSequence: PortableRawInteger;
    eventType: string;
    sessionId: string;
    sessionSequence: PortableRawInteger;
    category: string;
    data: string;
    priority: PortableRawInteger;
    sourceHook: string;
    createdAt: PortableRawTimestamp;
    disposition: "pending" | "applied" | "quarantined";
  }>;
}>;

export type PortableRawRecordValueByDomain = PortableRecordValueInputByDomain;

export type PortableRawRecordInput<D extends PortableDomain = PortableDomain> = Readonly<{
  domain: D;
  ordinal: number;
  context: PortableRecordConstructionContext<D>;
  value: PortableRecordValueInputByDomain[D];
}>;

export type PortableProjectIdentity =
  | Readonly<{ scope: "shared"; projectId: string }>
  | Readonly<{ scope: "local"; projectId: string }>;

export type PortableRecordValueByDomain = Readonly<{
  machines: Readonly<{ identityKey: string; machineId: string | null }>;
  project: Readonly<{ identity: PortableProjectIdentity }>;
  "project-aliases": Readonly<{
    machineIdentityKey: string;
    path: string;
    normalizedPath: string;
  }>;
  conversations: Readonly<{
    conversationFingerprint: string;
    occurrenceOrdinal: PortableNonnegativeSafeInteger;
    sessionId: string;
    createdAt: PortableTimestamp;
    title: string | null;
    bootstrappedAt: PortableTimestamp | null;
    updatedAt: PortableTimestamp;
  }>;
  messages: Readonly<{
    conversationIdentitySha256: string;
    seq: PortableNonnegativeInt64;
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tokenCount: PortableNonnegativeInt64;
    createdAt: PortableTimestamp;
  }>;
  "message-parts": Readonly<{
    messageIdentitySha256: string;
    partId: string;
    sessionId: string;
    partType:
      | "text"
      | "reasoning"
      | "tool"
      | "patch"
      | "file"
      | "subtask"
      | "compaction"
      | "step_start"
      | "step_finish"
      | "snapshot"
      | "agent"
      | "retry";
    ordinal: PortableNonnegativeInt64;
    textContent: string | null;
    isIgnored: boolean | null;
    isSynthetic: boolean | null;
    toolCallId: string | null;
    toolName: string | null;
    toolStatus: string | null;
    toolInput: string | null;
    toolOutput: string | null;
    toolError: string | null;
    toolTitle: string | null;
    patchHash: string | null;
    patchFiles: string | null;
    fileMime: string | null;
    fileName: string | null;
    fileUrl: string | null;
    subtaskPrompt: string | null;
    subtaskDescription: string | null;
    subtaskAgent: string | null;
    stepReason: string | null;
    stepCost: number | null;
    stepTokensIn: PortableNonnegativeInt64 | null;
    stepTokensOut: PortableNonnegativeInt64 | null;
    snapshotHash: string | null;
    compactionAuto: boolean | null;
    metadata: string | null;
  }>;
  "large-files": Readonly<{
    fileId: string;
    conversationIdentitySha256: string;
    fileName: string | null;
    mimeType: string | null;
    byteSize: PortableNonnegativeInt64 | null;
    storageUri: string;
    explorationSummary: string | null;
    createdAt: PortableTimestamp;
  }>;
  summaries: Readonly<{
    summaryId: string;
    conversationIdentitySha256: string;
    kind: "leaf" | "condensed";
    depth: PortableNonnegativeInt4;
    content: string;
    tokenCount: PortableNonnegativeInt64;
    earliestAt: PortableTimestamp | null;
    latestAt: PortableTimestamp | null;
    descendantCount: PortableNonnegativeInt64;
    descendantTokenCount: PortableNonnegativeInt64;
    sourceMessageTokenCount: PortableNonnegativeInt64;
    createdAt: PortableTimestamp;
  }>;
  "summary-file-links": Readonly<{
    summaryId: string;
    ordinal: PortableNonnegativeInt4;
    fileId: string;
  }>;
  "summary-message-links": Readonly<{
    summaryId: string;
    ordinal: PortableNonnegativeInt4;
    messageIdentitySha256: string;
  }>;
  "summary-parent-links": Readonly<{
    summaryId: string;
    ordinal: PortableNonnegativeInt4;
    parentSummaryId: string;
  }>;
  "context-items": Readonly<{
    conversationIdentitySha256: string;
    ordinal: PortableNonnegativeInt4;
    itemType: "message" | "summary";
    messageIdentitySha256: string | null;
    summaryId: string | null;
    createdAt: PortableTimestamp;
  }>;
  "promoted-memories": Readonly<{
    memoryId: string;
    content: string;
    metadata: JsonObject;
    sourceProjectId: string | null;
    sourceSummaryId: string | null;
    sessionId: string | null;
    depth: PortableNonnegativeInt4;
    confidence: number;
    createdAt: PortableTimestamp;
    archivedAt: PortableTimestamp | null;
  }>;
  "promoted-memory-tags": Readonly<{
    memoryId: string;
    ordinal: PortableNonnegativeInt4;
    tag: string;
  }>;
  "recall-surfacings": Readonly<{
    memoryId: string;
    sessionId: string | null;
    surfacedAt: PortableTimestamp;
    occurrenceOrdinal: PortableNonnegativeSafeInteger;
  }>;
  "redaction-counters": Readonly<{
    category: "built_in" | "global" | "project" | "gitleaks";
    count: PortableNonnegativeInt64;
  }>;
  "session-ingest": Readonly<{
    sessionId: string;
    messageCount: PortableNonnegativeInt64;
    completedAt: PortableTimestamp;
  }>;
  "session-instructions": Readonly<{
    machineIdentityKey: string;
    scopeHash: string;
    clientName: "claude" | "codex";
    sessionId: string;
    worktreePath: string;
    cwdPath: string;
    content: string;
    contentHash: string;
    updatedAt: PortableTimestamp;
  }>;
  "native-transcripts": Readonly<{
    machineIdentityKey: string;
    clientName: string;
    formatName: string;
    formatVersion: string;
    nativeSessionId: string;
    sourceLocator: string;
    sourceOrdinal: PortableNonnegativeInt64;
    observedAt: PortableTimestamp;
    ingestedAt: PortableTimestamp;
    scrubberVersion: string;
    contentSha256: string;
    ingestKey: string;
    nativePayload: JsonObject | readonly JsonValue[];
  }>;
  "native-transcript-message-links": Readonly<{
    machineIdentityKey: string;
    ingestKey: string;
    sourceOrdinal: PortableNonnegativeInt4;
    conversationIdentitySha256: string;
    messageIdentitySha256: string;
  }>;
  "native-transcript-checkpoints": Readonly<{
    machineIdentityKey: string;
    clientName: string;
    sourceLocator: string;
    revision: PortableNonnegativeSafeInteger;
    lastSourceOrdinal: PortableNonnegativeInt64;
    importedCount: PortableNonnegativeInt64;
    skippedCount: PortableNonnegativeInt64;
    quarantinedCount: PortableNonnegativeInt64;
    checkpoint: JsonObject;
    updatedAt: PortableTimestamp;
  }>;
  "passive-events": Readonly<{
    machineIdentityKey: string;
    eventId: string;
    eventVersion: PortablePositiveInt4;
    machineSequence: PortableNonnegativeInt64;
    eventType: string;
    sessionId: string;
    sessionSequence: PortableNonnegativeSafeInteger;
    category: string;
    data: string;
    priority: PortableSignedSafeInteger;
    sourceHook: string;
    createdAt: PortableTimestamp;
    disposition: "pending" | "applied" | "quarantined";
  }>;
}>;

/**
 * The runtime schema descriptor is deliberately data, rather than an inferred
 * reflection of the TypeScript types above.  Adapters and parsers bind to this
 * frozen descriptor so a source cannot silently change the wire contract by
 * adding a field to a local interface.
 */
const PORTABLE_RECORD_SCHEMA_BASE = {
  version: 1,
  domains: PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => ({
    domain,
    domainVersion: 1,
    ordinal: index,
  })),
  envelope: [
    "version",
    "domain",
    "domainVersion",
    "ordinal",
    "order",
    "identitySha256",
    "dependencies",
    "value",
    "recordSha256",
  ],
  dependency: ["domain", "identitySha256"],
  canonicalization: {
    integers: {
      encoding: { $integer: "decimal-string" },
      signedInt64: ["-9223372036854775808", "9223372036854775807"],
      nonnegativeInt64: ["0", "9223372036854775807"],
      positiveInt4: ["1", "2147483647"],
      nonnegativeInt4: ["0", "2147483647"],
      signedSafeInteger: [-9007199254740991, 9007199254740991],
      nonnegativeSafeInteger: [0, 9007199254740991],
    },
    timestamp: "utc-rfc3339-six-fractional-digits",
    json: {
      objectKeys: "unsigned-utf8-code-unit-order",
      arrays: "ordered-with-duplicates",
      maxDepth: PORTABLE_LIMITS.maxJsonDepth,
      numbers: "finite-safe-ecmascript-json-spelling",
      strings: "well-formed-utf16-without-nul",
    },
    hashes: "lowercase-sha256-canonical-utf8",
  },
  limits: PORTABLE_LIMITS,
  domainsByOrder: {
    machines: {
      logicalKey: ["identityKey"],
      identityOrderPrefix: ["identityKey"],
      order: ["identityKey"],
      dependencies: [],
      fields: ["identityKey", "machineId"],
      rules: ["string", "uuidv7|null"],
      coverage: ["identity-sidecar"],
    },
    project: {
      logicalKey: ["identity.scope", "identity.projectId"],
      identityOrderPrefix: ["scope", "projectId"],
      order: ["scope", "projectId"],
      dependencies: [],
      fields: ["identity"],
      rules: ["project-identity"],
      coverage: ["identity-sidecar"],
    },
    "project-aliases": {
      logicalKey: ["machineIdentityKey", "normalizedPath"],
      identityOrderPrefix: ["machineIdentityKey", "normalizedPath"],
      order: ["machineIdentityKey", "normalizedPath", "path"],
      dependencies: ["machines", "project"],
      fields: ["machineIdentityKey", "path", "normalizedPath"],
      rules: ["string", "path", "normalized-path"],
      coverage: ["identity-sidecar"],
    },
    conversations: {
      logicalKey: ["conversationFingerprint", "occurrenceOrdinal"],
      identityOrderPrefix: ["sessionId", "title", "bootstrappedAt", "createdAt", "updatedAt", "occurrenceOrdinal"],
      order: ["sessionId", "title", "bootstrappedAt", "createdAt", "updatedAt", "occurrenceOrdinal"],
      dependencies: ["project"],
      fields: ["conversationFingerprint", "occurrenceOrdinal", "sessionId", "createdAt", "title", "bootstrappedAt", "updatedAt"],
      rules: ["sha256", "nonnegative-safe-integer", "string", "timestamp", "string|null", "timestamp|null", "timestamp"],
      coverage: ["database"],
    },
    messages: {
      logicalKey: ["conversationIdentitySha256", "seq"],
      identityOrderPrefix: ["sessionId", "title", "bootstrappedAt", "conversationCreatedAt", "conversationUpdatedAt", "conversationOccurrenceOrdinal", "seq"],
      order: ["sessionId", "title", "bootstrappedAt", "conversationCreatedAt", "conversationUpdatedAt", "conversationOccurrenceOrdinal", "seq"],
      dependencies: ["conversations"],
      fields: ["conversationIdentitySha256", "seq", "role", "content", "tokenCount", "createdAt"],
      rules: ["sha256", "nonnegative-int64", "role", "string", "nonnegative-int64", "timestamp"],
      coverage: ["database"],
    },
    "message-parts": {
      logicalKey: ["messageIdentitySha256", "ordinal"],
      identityOrderPrefix: ["sessionId", "title", "bootstrappedAt", "conversationCreatedAt", "conversationUpdatedAt", "conversationOccurrenceOrdinal", "messageSeq", "ordinal"],
      order: [
        "sessionId",
        "title",
        "bootstrappedAt",
        "conversationCreatedAt",
        "conversationUpdatedAt",
        "conversationOccurrenceOrdinal",
        "messageSeq",
        "ordinal",
      ],
      dependencies: ["messages"],
      fields: [
        "messageIdentitySha256", "partId", "sessionId", "partType", "ordinal", "textContent", "isIgnored", "isSynthetic",
        "toolCallId", "toolName", "toolStatus", "toolInput", "toolOutput", "toolError", "toolTitle", "patchHash",
        "patchFiles", "fileMime", "fileName", "fileUrl", "subtaskPrompt", "subtaskDescription", "subtaskAgent", "stepReason",
        "stepCost", "stepTokensIn", "stepTokensOut", "snapshotHash", "compactionAuto", "metadata",
      ],
      rules: [
        "sha256", "string", "string", "part-type", "nonnegative-int64", "string|null", "boolean|null",
        "boolean|null", "string|null", "string|null", "string|null", "string|null", "string|null", "string|null",
        "string|null", "string|null", "string|null", "string|null", "string|null", "string|null", "string|null",
        "string|null", "string|null", "string|null", "finite-float-nonnegative|null", "nonnegative-int64|null",
        "nonnegative-int64|null", "string|null", "boolean|null", "string|null",
      ],
      coverage: ["database"],
    },
    "large-files": {
      logicalKey: ["fileId"],
      identityOrderPrefix: ["fileId"],
      order: ["fileId"],
      dependencies: ["conversations"],
      fields: ["fileId", "conversationIdentitySha256", "fileName", "mimeType", "byteSize", "storageUri", "explorationSummary", "createdAt"],
      rules: ["string", "sha256", "string|null", "string|null", "nonnegative-int64|null", "string", "string|null", "timestamp"],
      coverage: ["database"],
    },
    summaries: {
      logicalKey: ["summaryId"],
      identityOrderPrefix: ["summaryId"],
      order: ["summaryId"],
      dependencies: ["conversations"],
      fields: ["summaryId", "conversationIdentitySha256", "kind", "depth", "content", "tokenCount", "earliestAt", "latestAt", "descendantCount", "descendantTokenCount", "sourceMessageTokenCount", "createdAt"],
      rules: ["string", "sha256", "summary-kind", "nonnegative-int4", "string", "nonnegative-int64", "timestamp|null", "timestamp|null", "nonnegative-int64", "nonnegative-int64", "nonnegative-int64", "timestamp"],
      coverage: ["database"],
    },
    "summary-file-links": {
      logicalKey: ["summaryId", "ordinal"],
      identityOrderPrefix: ["summaryId", "ordinal"],
      order: ["summaryId", "ordinal"],
      dependencies: ["summaries"],
      fields: ["summaryId", "ordinal", "fileId"],
      rules: ["string", "nonnegative-int4", "string"],
      coverage: ["database"],
    },
    "summary-message-links": {
      logicalKey: ["summaryId", "messageIdentitySha256"],
      identityOrderPrefix: ["summaryId", "messageIdentitySha256"],
      order: ["summaryId", "messageIdentitySha256", "ordinal"],
      dependencies: ["summaries", "messages"],
      fields: ["summaryId", "ordinal", "messageIdentitySha256"],
      rules: ["string", "nonnegative-int4", "sha256"],
      coverage: ["database"],
    },
    "summary-parent-links": {
      logicalKey: ["summaryId", "parentSummaryId"],
      identityOrderPrefix: ["summaryId", "parentSummaryId"],
      order: ["summaryId", "parentSummaryId", "ordinal"],
      dependencies: ["summaries"],
      fields: ["summaryId", "ordinal", "parentSummaryId"],
      rules: ["string", "nonnegative-int4", "string"],
      coverage: ["database"],
    },
    "context-items": {
      logicalKey: ["conversationIdentitySha256", "ordinal"],
      identityOrderPrefix: ["sessionId", "title", "bootstrappedAt", "conversationCreatedAt", "conversationUpdatedAt", "conversationOccurrenceOrdinal", "ordinal"],
      order: ["sessionId", "title", "bootstrappedAt", "conversationCreatedAt", "conversationUpdatedAt", "conversationOccurrenceOrdinal", "ordinal"],
      dependencies: ["conversations", "messages|summaries"],
      fields: ["conversationIdentitySha256", "ordinal", "itemType", "messageIdentitySha256", "summaryId", "createdAt"],
      rules: ["sha256", "nonnegative-int4", "context-target", "sha256|null", "string|null", "timestamp"],
      coverage: ["database"],
    },
    "promoted-memories": {
      logicalKey: ["memoryId"],
      identityOrderPrefix: ["memoryId"],
      order: ["memoryId"],
      dependencies: ["project"],
      fields: ["memoryId", "content", "metadata", "sourceProjectId", "sourceSummaryId", "sessionId", "depth", "confidence", "createdAt", "archivedAt"],
      rules: ["string", "string", "json-object", "string|null", "string|null", "string|null", "nonnegative-int4", "finite-float-0..1", "timestamp", "timestamp|null"],
      coverage: ["database"],
    },
    "promoted-memory-tags": {
      logicalKey: ["memoryId", "ordinal"],
      identityOrderPrefix: ["memoryId", "ordinal"],
      order: ["memoryId", "ordinal"],
      dependencies: ["promoted-memories"],
      fields: ["memoryId", "ordinal", "tag"],
      rules: ["string", "nonnegative-int4", "string"],
      coverage: ["database"],
    },
    "recall-surfacings": {
      logicalKey: ["memoryId", "sessionId", "surfacedAt", "occurrenceOrdinal"],
      identityOrderPrefix: ["memoryId", "sessionId", "surfacedAt", "occurrenceOrdinal"],
      order: ["memoryId", "sessionId", "surfacedAt", "occurrenceOrdinal"],
      dependencies: ["project"],
      fields: ["memoryId", "sessionId", "surfacedAt", "occurrenceOrdinal"],
      rules: ["string", "string|null", "timestamp", "nonnegative-safe-integer"],
      coverage: ["database"],
    },
    "redaction-counters": {
      logicalKey: ["category"],
      identityOrderPrefix: ["category"],
      order: ["category"],
      dependencies: ["project"],
      fields: ["category", "count"],
      rules: ["redaction-category", "nonnegative-int64"],
      coverage: ["database"],
    },
    "session-ingest": {
      logicalKey: ["sessionId"],
      identityOrderPrefix: ["sessionId"],
      order: ["sessionId"],
      dependencies: ["project"],
      fields: ["sessionId", "messageCount", "completedAt"],
      rules: ["string", "nonnegative-int64", "timestamp"],
      coverage: ["database"],
    },
    "session-instructions": {
      logicalKey: ["machineIdentityKey", "scopeHash"],
      identityOrderPrefix: ["machineIdentityKey", "scopeHash"],
      order: ["machineIdentityKey", "scopeHash"],
      dependencies: ["machines", "project"],
      fields: ["machineIdentityKey", "scopeHash", "clientName", "sessionId", "worktreePath", "cwdPath", "content", "contentHash", "updatedAt"],
      rules: ["string", "sha256", "client", "string", "path", "path", "string", "sha256", "timestamp"],
      coverage: ["database-and-identity"],
    },
    "native-transcripts": {
      logicalKey: ["machineIdentityKey", "ingestKey"],
      identityOrderPrefix: ["machineIdentityKey", "ingestKey"],
      order: ["machineIdentityKey", "ingestKey"],
      dependencies: ["machines", "project"],
      fields: ["machineIdentityKey", "clientName", "formatName", "formatVersion", "nativeSessionId", "sourceLocator", "sourceOrdinal", "observedAt", "ingestedAt", "scrubberVersion", "contentSha256", "ingestKey", "nativePayload"],
      rules: ["string", "string", "string", "string", "string", "path", "nonnegative-int64", "timestamp", "timestamp", "string", "sha256", "sha256", "json-object-or-array"],
      coverage: ["database-or-sidecar"],
    },
    "native-transcript-message-links": {
      logicalKey: ["machineIdentityKey", "ingestKey", "sourceOrdinal"],
      identityOrderPrefix: ["machineIdentityKey", "ingestKey", "sourceOrdinal"],
      order: ["machineIdentityKey", "ingestKey", "sourceOrdinal"],
      dependencies: ["native-transcripts", "messages"],
      fields: ["machineIdentityKey", "ingestKey", "sourceOrdinal", "conversationIdentitySha256", "messageIdentitySha256"],
      rules: ["string", "sha256", "nonnegative-int4", "sha256", "sha256"],
      coverage: ["database-or-sidecar"],
    },
    "native-transcript-checkpoints": {
      logicalKey: ["machineIdentityKey", "clientName", "sourceLocator"],
      identityOrderPrefix: ["machineIdentityKey", "clientName", "sourceLocator"],
      order: ["machineIdentityKey", "clientName", "sourceLocator"],
      dependencies: ["machines", "project"],
      fields: ["machineIdentityKey", "clientName", "sourceLocator", "revision", "lastSourceOrdinal", "importedCount", "skippedCount", "quarantinedCount", "checkpoint", "updatedAt"],
      rules: ["string", "string", "path", "nonnegative-safe-integer", "nonnegative-int64", "nonnegative-int64", "nonnegative-int64", "nonnegative-int64", "json-object", "timestamp"],
      coverage: ["database-or-sidecar"],
    },
    "passive-events": {
      logicalKey: ["machineIdentityKey", "eventId"],
      identityOrderPrefix: ["machineIdentityKey", "eventId"],
      order: ["machineIdentityKey", "eventId", "machineSequence"],
      dependencies: ["machines", "project"],
      fields: ["machineIdentityKey", "eventId", "eventVersion", "machineSequence", "eventType", "sessionId", "sessionSequence", "category", "data", "priority", "sourceHook", "createdAt", "disposition"],
      rules: ["string", "uuid", "positive-int4", "nonnegative-int64", "string", "string", "nonnegative-safe-integer", "string", "string", "signed-safe-integer", "string", "timestamp", "disposition"],
      coverage: ["database-or-sidecar"],
    },
  },
} as const;

const NULL_CONSTRUCTION_CONTEXT = Object.freeze({
  constructionContext: [],
  contextValidation: ["exact-null"],
} as const);

const PROJECT_CONSTRUCTION_CONTEXT = Object.freeze({
  constructionContext: ["projectIdentity"],
  contextValidation: ["exact-object", "derive-project-dependency"],
} as const);

const PORTABLE_CONSTRUCTION_CONTEXT_DESCRIPTOR = Object.freeze({
  machines: NULL_CONSTRUCTION_CONTEXT,
  project: NULL_CONSTRUCTION_CONTEXT,
  "project-aliases": PROJECT_CONSTRUCTION_CONTEXT,
  conversations: Object.freeze({
    constructionContext: ["projectIdentity"],
    contextValidation: ["exact-object", "derive-project-dependency", "bind-conversation-fingerprint"],
  } as const),
  messages: Object.freeze({
    constructionContext: ["conversationOrder"],
    contextValidation: ["exact-object", "normalize-conversation-order", "bind-conversation-identity"],
  } as const),
  "message-parts": Object.freeze({
    constructionContext: ["messageOrder"],
    contextValidation: ["exact-object", "normalize-message-order", "bind-message-identity"],
  } as const),
  "large-files": NULL_CONSTRUCTION_CONTEXT,
  summaries: NULL_CONSTRUCTION_CONTEXT,
  "summary-file-links": NULL_CONSTRUCTION_CONTEXT,
  "summary-message-links": NULL_CONSTRUCTION_CONTEXT,
  "summary-parent-links": NULL_CONSTRUCTION_CONTEXT,
  "context-items": Object.freeze({
    constructionContext: ["conversationOrder"],
    contextValidation: ["exact-object", "normalize-conversation-order", "bind-conversation-identity"],
  } as const),
  "promoted-memories": PROJECT_CONSTRUCTION_CONTEXT,
  "promoted-memory-tags": NULL_CONSTRUCTION_CONTEXT,
  "recall-surfacings": PROJECT_CONSTRUCTION_CONTEXT,
  "redaction-counters": PROJECT_CONSTRUCTION_CONTEXT,
  "session-ingest": PROJECT_CONSTRUCTION_CONTEXT,
  "session-instructions": PROJECT_CONSTRUCTION_CONTEXT,
  "native-transcripts": Object.freeze({
    constructionContext: ["projectIdentity", "canonicalPayloadBytes", "canonicalMetadataBytes"],
    contextValidation: [
      "exact-object",
      "derive-project-dependency",
      "match-canonical-payload-bytes",
      "match-canonical-metadata-bytes",
      "enforce-native-byte-limits",
    ],
  } as const),
  "native-transcript-message-links": NULL_CONSTRUCTION_CONTEXT,
  "native-transcript-checkpoints": PROJECT_CONSTRUCTION_CONTEXT,
  "passive-events": PROJECT_CONSTRUCTION_CONTEXT,
} as const);

const CONVERSATION_CLOSURE_DESCRIPTOR = Object.freeze({
  projections: [
    ["messages", "seq", "value-without-conversationIdentitySha256"],
    ["message-parts", "messageSeq", "ordinal", "value-without-messageIdentitySha256"],
    ["large-files", "value-with-conversationFingerprint"],
    ["summaries", "value-with-conversationFingerprint"],
    ["summary-file-links", "reachable-summary-value"],
    ["summary-parent-links", "reachable-summary-value"],
    [
      "summary-message-links",
      "summaryId",
      "ordinal",
      "referencedConversationFingerprint",
      "referencedMessageSeq",
    ],
    [
      "context-items",
      "ordinal",
      "itemType",
      "referencedConversationFingerprint",
      "referencedMessageSeq|null",
      "summaryId|null",
      "createdAt",
    ],
    [
      "native-transcript-message-links",
      "machineIdentityKey",
      "ingestKey",
      "sourceOrdinal",
      "referencedConversationFingerprint",
      "referencedMessageSeq",
    ],
  ],
  forbiddenProjectionFields: ["conversationIdentitySha256", "messageIdentitySha256"],
  externalMessageReference: ["conversationFingerprint", "messageSeq"],
  algorithm: [
    "full-closure",
    "digest",
    "full-byte-collision-check",
    "preserve-class-multiplicity",
    "unsigned-digest-class-sort",
    "contiguous-ordinal-block",
  ],
} as const);

type AugmentedDomainDescriptor<D extends PortableDomain> =
  (typeof PORTABLE_RECORD_SCHEMA_BASE.domainsByOrder)[D] &
  (typeof PORTABLE_CONSTRUCTION_CONTEXT_DESCRIPTOR)[D] &
  (D extends "conversations"
    ? Readonly<{ conversationClosure: typeof CONVERSATION_CLOSURE_DESCRIPTOR }>
    : object);

type AugmentedDomainsByOrder = Readonly<{
  [D in PortableDomain]: AugmentedDomainDescriptor<D>;
}>;

const augmentedDomainsByOrder = Object.fromEntries(
  PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [
    domain,
    {
      ...PORTABLE_RECORD_SCHEMA_BASE.domainsByOrder[domain],
      ...PORTABLE_CONSTRUCTION_CONTEXT_DESCRIPTOR[domain],
      constructionContext: [...PORTABLE_CONSTRUCTION_CONTEXT_DESCRIPTOR[domain].constructionContext],
      contextValidation: [...PORTABLE_CONSTRUCTION_CONTEXT_DESCRIPTOR[domain].contextValidation],
      ...(domain === "conversations" ? { conversationClosure: CONVERSATION_CLOSURE_DESCRIPTOR } : {}),
    },
  ]),
) as unknown as AugmentedDomainsByOrder;

function stringArray(value: unknown): readonly string[] | null {
  try {
    const values = plainDenseArrayElements(value);
    for (const item of values) if (typeof item !== "string") return null;
    return values as readonly string[];
  } catch {
    return null;
  }
}

function sameStrings(left: unknown, right: readonly string[]): boolean {
  const values = stringArray(left);
  if (values === null || values.length !== right.length) return false;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== right[index]) return false;
  }
  return true;
}

const PORTABLE_CANONICALIZATION_DESCRIPTOR = {
  ...PORTABLE_RECORD_SCHEMA_BASE.canonicalization,
  objectKeyOrder: "unsigned-utf16-code-unit-order",
  tupleStringOrder: "unsigned-utf8-byte-order",
  json: {
    ...PORTABLE_RECORD_SCHEMA_BASE.canonicalization.json,
    objectKeys: "unsigned-utf16-code-unit-order",
  },
} as const;

/** Validate the frozen schema's executable ordering and reconstruction invariants. */
export function validatePortableRecordSchemaDescriptor(descriptor: unknown): boolean {
  try {
    const root = snapshotExactObject(descriptor, [
      "version", "domains", "envelope", "dependency", "canonicalization", "limits", "domainsByOrder",
    ]);
    if (root.version !== 1) return false;
    const domains = plainDenseArrayElements(root.domains);
    if (domains.length !== PORTABLE_RECORD_DOMAIN_ORDER.length) return false;
    const domainsByOrder = snapshotExactObject(root.domainsByOrder, PORTABLE_RECORD_DOMAIN_ORDER);
    if (
      !sameStrings(root.envelope, PORTABLE_RECORD_SCHEMA_BASE.envelope)
      || !sameStrings(root.dependency, PORTABLE_RECORD_SCHEMA_BASE.dependency)
      || canonicalJson(root.canonicalization) !== canonicalJson(PORTABLE_CANONICALIZATION_DESCRIPTOR)
      || canonicalJson(root.limits) !== canonicalJson(PORTABLE_LIMITS)
    ) return false;

    for (let index = 0; index < PORTABLE_RECORD_DOMAIN_ORDER.length; index += 1) {
      const domain = PORTABLE_RECORD_DOMAIN_ORDER[index];
      const inventory = snapshotExactObject(domains[index], ["domain", "domainVersion", "ordinal"]);
      if (inventory.domain !== domain || inventory.domainVersion !== 1 || inventory.ordinal !== index) return false;

      const expected = PORTABLE_RECORD_SCHEMA_BASE.domainsByOrder[domain];
      const context = PORTABLE_CONSTRUCTION_CONTEXT_DESCRIPTOR[domain];
      const candidate = snapshotExactObject(domainsByOrder[domain], [
        "logicalKey", "identityOrderPrefix", "order", "dependencies", "fields", "rules", "coverage",
        "constructionContext", "contextValidation",
        ...(domain === "conversations" ? ["conversationClosure"] : []),
      ]);
      const fields = stringArray(candidate.fields);
      const rules = stringArray(candidate.rules);
      const order = stringArray(candidate.order);
      const identityPrefix = stringArray(candidate.identityOrderPrefix);
      const coverage = stringArray(candidate.coverage);
      const dependencies = stringArray(candidate.dependencies);
      if (dependencies === null) return false;
      for (const dependency of dependencies) {
        for (const alternative of dependency.split("|")) {
          if (PORTABLE_RECORD_DOMAIN_ORDER.indexOf(alternative as PortableDomain) >= index) return false;
        }
      }
      if (
        fields === null
        || rules === null
        || fields.length !== rules.length
        || order === null
        || identityPrefix === null
        || identityPrefix.length === 0
        || identityPrefix.length > order.length
        || !identityPrefix.every((field, position) => field === order[position])
        || coverage === null
        || coverage.length === 0
        || !sameStrings(candidate.fields, expected.fields)
        || !sameStrings(candidate.rules, expected.rules)
        || !sameStrings(candidate.order, expected.order)
        || !sameStrings(candidate.identityOrderPrefix, expected.identityOrderPrefix)
        || !sameStrings(candidate.logicalKey, expected.logicalKey)
        || !sameStrings(dependencies, expected.dependencies)
        || !sameStrings(candidate.coverage, expected.coverage)
        || !sameStrings(candidate.constructionContext, context.constructionContext)
        || !sameStrings(candidate.contextValidation, context.contextValidation)
        || (
          domain === "conversations"
          && canonicalJson(candidate.conversationClosure) !== canonicalJson(CONVERSATION_CLOSURE_DESCRIPTOR)
        )
      ) return false;

    }
    return true;
  } catch {
    return false;
  }
}

const portableRecordSchemaDescriptor = deepFreeze({
  ...PORTABLE_RECORD_SCHEMA_BASE,
  canonicalization: PORTABLE_CANONICALIZATION_DESCRIPTOR,
  domainsByOrder: augmentedDomainsByOrder,
} as const);

export const PORTABLE_RECORD_SCHEMA_DESCRIPTOR = portableRecordSchemaDescriptor;

export type PortableRecordValue = PortableRecordValueByDomain[PortableDomain];

export interface PortableRecord<D extends PortableDomain = PortableDomain> {
  readonly version: 1;
  readonly domain: D;
  readonly domainVersion: 1;
  readonly ordinal: number;
  readonly order: readonly PortableOrderScalar[];
  readonly identitySha256: string;
  readonly dependencies: readonly Readonly<{
    readonly domain: PortableDomain;
    readonly identitySha256: string;
  }>[];
  readonly value: PortableRecordValueByDomain[D];
  readonly recordSha256: string;
}

export interface PortableRecordInput<D extends PortableDomain = PortableDomain> {
  readonly domain: D;
  readonly ordinal: number;
  readonly value: PortableRecordValueInputByDomain[D];
  readonly context: PortableRecordConstructionContextByDomain[D];
}

export interface PortableStreamErrorOptions {
  readonly domain?: PortableDomain;
  readonly ordinal?: number;
  readonly recordCount?: number;
  readonly manifestSha256?: string;
  readonly checkpointSha256?: string;
  readonly retryable?: boolean;
}

export type PortableStreamErrorCode =
  | "unsupported-version"
  | "unknown-domain"
  | "malformed-record"
  | "record-unrepresentable"
  | "duplicate-identity"
  | "order-regression"
  | "dependency-order";

const PORTABLE_STREAM_ERROR_CODES: readonly PortableStreamErrorCode[] = Object.freeze([
  "unsupported-version",
  "unknown-domain",
  "malformed-record",
  "record-unrepresentable",
  "duplicate-identity",
  "order-regression",
  "dependency-order",
]);

export class PortableStreamError extends Error {
  readonly code: PortableStreamErrorCode;
  readonly retryable: boolean;
  readonly domain?: PortableDomain;
  readonly ordinal?: number;
  readonly recordCount?: number;
  readonly manifestSha256?: string;
  readonly checkpointSha256?: string;

  constructor(code: PortableStreamErrorCode, options: PortableStreamErrorOptions = {}) {
    const normalizedCode = PORTABLE_STREAM_ERROR_CODES.includes(code)
      ? code
      : "malformed-record";
    super(`Portable record stream error: ${normalizedCode}`);
    this.name = "PortableStreamError";
    this.code = normalizedCode;
    const retryable = readErrorOption(options, "retryable");
    this.retryable = typeof retryable === "boolean" ? retryable : false;
    const domain = readErrorOption(options, "domain");
    if (isPortableDomainValue(domain)) this.domain = domain;
    const ordinal = readErrorOption(options, "ordinal");
    if (isNonnegativeSafeInteger(ordinal)) this.ordinal = ordinal;
    const recordCount = readErrorOption(options, "recordCount");
    if (isNonnegativeSafeInteger(recordCount)) this.recordCount = recordCount;
    const manifestSha256 = readErrorOption(options, "manifestSha256");
    if (isLowercaseSha256(manifestSha256)) this.manifestSha256 = manifestSha256;
    const checkpointSha256 = readErrorOption(options, "checkpointSha256");
    if (isLowercaseSha256(checkpointSha256)) this.checkpointSha256 = checkpointSha256;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      name: this.name,
      code: this.code,
      retryable: this.retryable,
    };
    if (this.domain !== undefined) result.domain = this.domain;
    if (this.ordinal !== undefined) result.ordinal = this.ordinal;
    if (this.recordCount !== undefined) result.recordCount = this.recordCount;
    if (this.manifestSha256 !== undefined) result.manifestSha256 = this.manifestSha256;
    if (this.checkpointSha256 !== undefined) result.checkpointSha256 = this.checkpointSha256;
    result.message = this.message;
    return result;
  }
}

const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;
const MAX_INT4 = 2n ** 31n - 1n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIX_DIGIT_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
const SQLITE_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

function fail(code: PortableStreamErrorCode, options: PortableStreamErrorOptions = {}): never {
  throw new PortableStreamError(code, options);
}

function malformed(options: PortableStreamErrorOptions = {}): never {
  return fail("malformed-record", options);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readErrorOption(options: unknown, key: string): unknown {
  if (!isObject(options)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isPortableDomainValue(value: unknown): value is PortableDomain {
  return typeof value === "string" && PORTABLE_RECORD_DOMAIN_ORDER.includes(value as PortableDomain);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && value >= 0;
}

function isLowercaseSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function ownKeys(value: object): PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    malformed();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function plainDenseArrayElements(value: unknown): unknown[] {
  let length: number;
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) malformed();
    length = (Object.getOwnPropertyDescriptor(value, "length") as { value: number }).value;
  } catch (error) {
    if (error instanceof PortableStreamError) throw error;
    malformed();
  }
  const keys = ownKeys(value);
  if (keys.length !== length + 1) malformed();
  const elements = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = ownPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) malformed();
    elements[index] = descriptor.value;
  }
  return elements;
}

function assertUtf16(value: string): void {
  if (value.includes("\u0000")) malformed();
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) malformed();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      malformed();
    }
  }
}

type IntegerInputMode = "raw" | "wire";

function decimalInteger(value: unknown, mode: IntegerInputMode): bigint {
  if (mode === "wire") {
    if (!isPlainObject(value) || !exactKeys(value, ["$integer"])) malformed();
    if (typeof value.$integer !== "string") malformed();
    value = value.$integer;
  }
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) malformed();
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^(?:0|-?[1-9]\d*)$/.test(value)) malformed();
  return BigInt(value);
}

function normalizeSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)) malformed();
  if (value < 0) malformed();
  return value;
}

function normalizeTimestamp(value: PortableRawTimestamp): string {
  let match: RegExpMatchArray | null;
  if (typeof value === "string") {
    match = value.match(SIX_DIGIT_TIMESTAMP_PATTERN);
    if (match === null) {
      match = value.match(SQLITE_TIMESTAMP_PATTERN);
      if (match === null) malformed();
      const fraction = (match[7] ?? "").padEnd(6, "0");
      value = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${fraction}Z`;
      match = value.match(SIX_DIGIT_TIMESTAMP_PATTERN);
    }
  } else {
    if (!(value instanceof Date) || Object.getPrototypeOf(value) !== Date.prototype) malformed();
    let iso: string;
    try {
      if (Number.isNaN(Date.prototype.getTime.call(value))) malformed();
      iso = Date.prototype.toISOString.call(value);
    } catch {
      malformed();
    }
    value = iso.replace(/(\.\d{3})Z$/, "$1000Z");
    match = value.match(SIX_DIGIT_TIMESTAMP_PATTERN);
  }
  if (match === null) malformed();
  const normalizedMatch = match;
  const year = Number(normalizedMatch[1]);
  const month = Number(normalizedMatch[2]);
  const day = Number(normalizedMatch[3]);
  const hour = Number(normalizedMatch[4]);
  const minute = Number(normalizedMatch[5]);
  const second = Number(normalizedMatch[6]);
  const microsecond = Number(normalizedMatch[7]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    microsecond > 999999
  ) malformed();
  return value;
}

function assertSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) malformed();
  return value;
}

function assertUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) malformed();
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!isObject(value) || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor & { value: unknown };
    deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function compareUtf8Strings(left: string, right: string): number {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.compare(b);
}

function compareUtf16CodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodeUnit = left.charCodeAt(index);
    const rightCodeUnit = right.charCodeAt(index);
    if (leftCodeUnit !== rightCodeUnit) return leftCodeUnit < rightCodeUnit ? -1 : 1;
  }
  return left.length - right.length;
}

function compareOrderScalar(left: PortableOrderScalar, right: PortableOrderScalar): number {
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;
  if (typeof left === "string") return typeof right === "string" ? compareUtf8Strings(left, right) : -1;
  if (typeof right === "string") return 1;
  const a = BigInt(left.$integer);
  const b = BigInt(right.$integer);
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateOrderScalar(value: unknown): PortableOrderScalar {
  if (value === null) return null;
  if (typeof value === "string") {
    assertUtf16(value);
    return value;
  }
  if (isPlainObject(value)) {
    return normalizeTaggedInteger(value, MIN_INT64, MAX_INT64, "wire");
  }
  malformed();
}

export function comparePortableOrder(
  left: readonly PortableOrderScalar[],
  right: readonly PortableOrderScalar[],
): number {
  const leftElements = plainDenseArrayElements(left);
  const rightElements = plainDenseArrayElements(right);
  if (leftElements.length !== rightElements.length) malformed();
  const leftScalars = new Array<PortableOrderScalar>(leftElements.length);
  const rightScalars = new Array<PortableOrderScalar>(rightElements.length);
  for (let index = 0; index < leftElements.length; index += 1) {
    leftScalars[index] = validateOrderScalar(leftElements[index]);
    rightScalars[index] = validateOrderScalar(rightElements[index]);
  }
  for (let index = 0; index < leftScalars.length; index += 1) {
    const comparison = compareOrderScalar(leftScalars[index], rightScalars[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function canonicalString(value: string): string {
  assertUtf16(value);
  return JSON.stringify(value);
}

function canonicalJsonValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  maximumDepth: number,
): string {
  if (depth > maximumDepth) malformed();
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return canonicalString(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value) || Object.is(value, -0)) malformed();
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) malformed();
      return JSON.stringify(value);
    case "bigint":
    case "undefined":
    case "function":
    case "symbol":
      malformed();
  }
  if (seen.has(value)) malformed();
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    const elements = plainDenseArrayElements(value);
    const encoded = new Array<string>(elements.length);
    for (let index = 0; index < elements.length; index += 1) {
      encoded[index] = canonicalJsonValue(elements[index], depth + 1, seen, maximumDepth);
    }
    result = `[${encoded.join(",")}]`;
  } else {
    if (!isPlainObject(value)) malformed();
    const keys = ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) malformed();
    const sorted = (keys as string[]).sort(compareUtf16CodeUnits);
    result = `{${sorted
      .map((key) => {
        const descriptor = ownPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor)) malformed();
        return `${canonicalString(key)}:${canonicalJsonValue(descriptor.value, depth + 1, seen, maximumDepth)}`;
      })
      .join(",")}}`;
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  return canonicalJsonValue(value, 0, new WeakSet<object>(), PORTABLE_LIMITS.maxJsonDepth);
}

function canonicalEnvelopeJson(value: unknown): string {
  return canonicalJsonValue(value, 0, new WeakSet<object>(), PORTABLE_LIMITS.maxJsonDepth + 4);
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256(canonicalJsonBytes(value));
}

export const PORTABLE_RECORD_SCHEMA_SHA256 = canonicalSha256([
  "lcm-portable-schema-v1",
  PORTABLE_RECORD_SCHEMA_DESCRIPTOR,
]);

const PORTABLE_RECORD_ENVELOPE_KEYS = [
  "version",
  "domain",
  "domainVersion",
  "ordinal",
  "order",
  "identitySha256",
  "dependencies",
  "value",
  "recordSha256",
] as const;

const PORTABLE_RECORD_IDENTITY_TAG = "lcm-portable-identity-v1";
const PORTABLE_CONVERSATION_VALUE_TAG = "lcm-portable-conversation-value-v1";
const MAX_NATIVE_PAYLOAD_BYTES = 100 * 1024 * 1024;

type PortableDependency = Readonly<{
  domain: PortableDomain;
  identitySha256: string;
}>;

type CanonicalConversationOrder = readonly [
  string,
  string | null,
  PortableTimestamp | null,
  PortableTimestamp,
  PortableTimestamp,
  PortableNonnegativeSafeInteger,
];

type CanonicalMessageOrder = readonly [
  ...CanonicalConversationOrder,
  PortableNonnegativeInt64,
];

interface ConstructionEvidence {
  readonly projectIdentitySha256?: string;
  readonly conversationOrder?: CanonicalConversationOrder;
  readonly messageOrder?: CanonicalMessageOrder;
  readonly canonicalPayloadBytes?: number;
  readonly canonicalMetadataBytes?: number;
}

interface PortableRecordShape {
  readonly domain: PortableDomain;
  readonly ordinal: number;
  readonly order: readonly PortableOrderScalar[];
  readonly logicalKey: readonly PortableOrderScalar[];
  readonly dependencies: readonly PortableDependency[];
  readonly value: PortableRecordValue;
}

function assertDomain(value: unknown): PortableDomain {
  if (typeof value !== "string" || !PORTABLE_RECORD_DOMAIN_ORDER.includes(value as PortableDomain)) {
    fail("unknown-domain");
  }
  return value as PortableDomain;
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = ownKeys(value);
  if (actual.length !== keys.length) return false;
  return keys.every((key) => {
    if (!actual.includes(key)) return false;
    const descriptor = ownPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
}

function ownPropertyDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    malformed();
  }
}

function snapshotExactObject(
  value: unknown,
  keys: readonly string[],
  domain?: PortableDomain,
): Record<string, unknown> {
  if (!isPlainObject(value) || !exactKeys(value, keys)) malformed(domain === undefined ? {} : { domain });
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = ownPropertyDescriptor(value, key) as PropertyDescriptor & { value: unknown };
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function nonemptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) malformed();
  assertUtf16(value);
  return value;
}

function portableString(value: unknown): string {
  if (typeof value !== "string") malformed();
  assertUtf16(value);
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : portableString(value);
}

function nullableBoolean(value: unknown): boolean | null {
  if (value !== null && typeof value !== "boolean") malformed();
  return value;
}

function finiteNumber(value: unknown, minimum = -Infinity, maximum = Infinity): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) malformed();
  return value;
}

function assertUuidV7OrNull(value: unknown): string | null {
  if (value === null) return null;
  const uuid = assertUuid(value);
  if (uuid !== uuid.toLowerCase() || uuid[14] !== "7") malformed();
  return uuid;
}

function expectExactObject(
  domain: PortableDomain,
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  return snapshotExactObject(value, keys, domain);
}

function normalizeProjectIdentity(value: unknown): PortableProjectIdentity {
  const identity = snapshotExactObject(value, ["scope", "projectId"]);
  const projectId = portableString(identity.projectId);
  if (identity.scope === "local") {
    assertSha256(projectId);
    return deepFreeze({ scope: "local", projectId });
  }
  if (identity.scope === "shared") {
    const uuid = assertUuid(projectId);
    if (uuid !== projectId || uuid !== uuid.toLowerCase() || uuid[14] !== "7") malformed();
    return deepFreeze({ scope: "shared", projectId });
  }
  malformed();
}

function validateOrdinal(value: unknown): number {
  return normalizeSafeInteger(value);
}

function normalizeTaggedInteger(
  value: unknown,
  minimum: bigint,
  maximum: bigint,
  mode: IntegerInputMode,
): PortableSignedInt64 {
  const integer = decimalInteger(value, mode);
  if (integer < minimum || integer > maximum) fail("record-unrepresentable");
  return Object.freeze({ $integer: integer.toString() }) as PortableSignedInt64;
}

function normalizeNonnegativeInt64(value: unknown, mode: IntegerInputMode): PortableNonnegativeInt64 {
  return normalizeTaggedInteger(value, 0n, MAX_INT64, mode) as unknown as PortableNonnegativeInt64;
}

function normalizePositiveInt4(value: unknown, mode: IntegerInputMode): PortablePositiveInt4 {
  return normalizeTaggedInteger(value, 1n, MAX_INT4, mode) as unknown as PortablePositiveInt4;
}

function normalizeNonnegativeInt4(value: unknown, mode: IntegerInputMode): PortableNonnegativeInt4 {
  return normalizeTaggedInteger(value, 0n, MAX_INT4, mode) as unknown as PortableNonnegativeInt4;
}

function normalizeSignedSafeInteger(value: unknown, mode: IntegerInputMode): PortableSignedSafeInteger {
  return normalizeTaggedInteger(value, -MAX_SAFE, MAX_SAFE, mode) as unknown as PortableSignedSafeInteger;
}

function normalizeNonnegativeSafeInteger(value: unknown, mode: IntegerInputMode): PortableNonnegativeSafeInteger {
  return normalizeTaggedInteger(value, 0n, MAX_SAFE, mode) as unknown as PortableNonnegativeSafeInteger;
}

function nullableInteger<T>(
  value: unknown,
  normalize: (input: unknown, mode: IntegerInputMode) => T,
  mode: IntegerInputMode,
): T | null {
  return value === null ? null : normalize(value, mode);
}

function nullableTimestamp(value: unknown): PortableTimestamp | null {
  return value === null ? null : normalizeTimestamp(value as PortableRawTimestamp) as PortableTimestamp;
}

function cloneCanonicalJson(value: unknown): JsonValue {
  const canonical = canonicalJson(value);
  return deepFreeze(JSON.parse(canonical) as JsonValue);
}

function cloneCanonicalJsonObject(value: unknown): JsonObject {
  if (!isPlainObject(value)) malformed();
  return cloneCanonicalJson(value) as JsonObject;
}

function cloneCanonicalJsonObjectOrArray(value: unknown): JsonObject | readonly JsonValue[] {
  if (!isPlainObject(value) && !Array.isArray(value)) malformed();
  return cloneCanonicalJson(value) as JsonObject | readonly JsonValue[];
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) malformed();
  return value as T;
}

function normalizeDomainValue(
  domain: PortableDomain,
  input: unknown,
  mode: IntegerInputMode,
): PortableRecordValue {
  const fields = PORTABLE_RECORD_SCHEMA_BASE.domainsByOrder[domain].fields;
  const value = expectExactObject(domain, input, fields);
  switch (domain) {
    case "machines":
      return deepFreeze({
        identityKey: nonemptyString(value.identityKey),
        machineId: assertUuidV7OrNull(value.machineId),
      });
    case "project":
      return deepFreeze({ identity: normalizeProjectIdentity(value.identity) });
    case "project-aliases":
      return deepFreeze({
        machineIdentityKey: nonemptyString(value.machineIdentityKey),
        path: nonemptyString(value.path),
        normalizedPath: nonemptyString(value.normalizedPath),
      });
    case "conversations": {
      const normalized = deepFreeze({
        conversationFingerprint: assertSha256(value.conversationFingerprint),
        occurrenceOrdinal: normalizeNonnegativeSafeInteger(value.occurrenceOrdinal, mode),
        sessionId: nonemptyString(value.sessionId),
        createdAt: normalizeTimestamp(value.createdAt as PortableRawTimestamp) as PortableTimestamp,
        title: nullableString(value.title),
        bootstrappedAt: nullableTimestamp(value.bootstrappedAt),
        updatedAt: normalizeTimestamp(value.updatedAt as PortableRawTimestamp) as PortableTimestamp,
      });
      const fingerprint = canonicalSha256([
        PORTABLE_CONVERSATION_VALUE_TAG,
        normalized.sessionId,
        normalized.title,
        normalized.bootstrappedAt,
        normalized.createdAt,
        normalized.updatedAt,
      ]);
      if (normalized.conversationFingerprint !== fingerprint) malformed({ domain });
      return normalized;
    }
    case "messages":
      return deepFreeze({
        conversationIdentitySha256: assertSha256(value.conversationIdentitySha256),
        seq: normalizeNonnegativeInt64(value.seq, mode),
        role: oneOf(value.role, ["system", "user", "assistant", "tool"] as const),
        content: portableString(value.content),
        tokenCount: normalizeNonnegativeInt64(value.tokenCount, mode),
        createdAt: normalizeTimestamp(value.createdAt as PortableRawTimestamp) as PortableTimestamp,
      });
    case "message-parts":
      return deepFreeze({
        messageIdentitySha256: assertSha256(value.messageIdentitySha256),
        partId: nonemptyString(value.partId),
        sessionId: nonemptyString(value.sessionId),
        partType: oneOf(value.partType, [
          "text", "reasoning", "tool", "patch", "file", "subtask", "compaction",
          "step_start", "step_finish", "snapshot", "agent", "retry",
        ] as const),
        ordinal: normalizeNonnegativeInt64(value.ordinal, mode),
        textContent: nullableString(value.textContent),
        isIgnored: nullableBoolean(value.isIgnored),
        isSynthetic: nullableBoolean(value.isSynthetic),
        toolCallId: nullableString(value.toolCallId),
        toolName: nullableString(value.toolName),
        toolStatus: nullableString(value.toolStatus),
        toolInput: nullableString(value.toolInput),
        toolOutput: nullableString(value.toolOutput),
        toolError: nullableString(value.toolError),
        toolTitle: nullableString(value.toolTitle),
        patchHash: nullableString(value.patchHash),
        patchFiles: nullableString(value.patchFiles),
        fileMime: nullableString(value.fileMime),
        fileName: nullableString(value.fileName),
        fileUrl: nullableString(value.fileUrl),
        subtaskPrompt: nullableString(value.subtaskPrompt),
        subtaskDescription: nullableString(value.subtaskDescription),
        subtaskAgent: nullableString(value.subtaskAgent),
        stepReason: nullableString(value.stepReason),
        stepCost: value.stepCost === null ? null : finiteNumber(value.stepCost, 0),
        stepTokensIn: nullableInteger(value.stepTokensIn, normalizeNonnegativeInt64, mode),
        stepTokensOut: nullableInteger(value.stepTokensOut, normalizeNonnegativeInt64, mode),
        snapshotHash: nullableString(value.snapshotHash),
        compactionAuto: nullableBoolean(value.compactionAuto),
        metadata: nullableString(value.metadata),
      });
    case "large-files":
      return deepFreeze({
        fileId: nonemptyString(value.fileId),
        conversationIdentitySha256: assertSha256(value.conversationIdentitySha256),
        fileName: nullableString(value.fileName),
        mimeType: nullableString(value.mimeType),
        byteSize: nullableInteger(value.byteSize, normalizeNonnegativeInt64, mode),
        storageUri: nonemptyString(value.storageUri),
        explorationSummary: nullableString(value.explorationSummary),
        createdAt: normalizeTimestamp(value.createdAt as PortableRawTimestamp) as PortableTimestamp,
      });
    case "summaries":
      return deepFreeze({
        summaryId: nonemptyString(value.summaryId),
        conversationIdentitySha256: assertSha256(value.conversationIdentitySha256),
        kind: oneOf(value.kind, ["leaf", "condensed"] as const),
        depth: normalizeNonnegativeInt4(value.depth, mode),
        content: portableString(value.content),
        tokenCount: normalizeNonnegativeInt64(value.tokenCount, mode),
        earliestAt: nullableTimestamp(value.earliestAt),
        latestAt: nullableTimestamp(value.latestAt),
        descendantCount: normalizeNonnegativeInt64(value.descendantCount, mode),
        descendantTokenCount: normalizeNonnegativeInt64(value.descendantTokenCount, mode),
        sourceMessageTokenCount: normalizeNonnegativeInt64(value.sourceMessageTokenCount, mode),
        createdAt: normalizeTimestamp(value.createdAt as PortableRawTimestamp) as PortableTimestamp,
      });
    case "summary-file-links":
      return deepFreeze({
        summaryId: nonemptyString(value.summaryId),
        ordinal: normalizeNonnegativeInt4(value.ordinal, mode),
        fileId: nonemptyString(value.fileId),
      });
    case "summary-message-links":
      return deepFreeze({
        summaryId: nonemptyString(value.summaryId),
        ordinal: normalizeNonnegativeInt4(value.ordinal, mode),
        messageIdentitySha256: assertSha256(value.messageIdentitySha256),
      });
    case "summary-parent-links": {
      const summaryId = nonemptyString(value.summaryId);
      const parentSummaryId = nonemptyString(value.parentSummaryId);
      if (summaryId === parentSummaryId) malformed({ domain });
      return deepFreeze({
        summaryId,
        ordinal: normalizeNonnegativeInt4(value.ordinal, mode),
        parentSummaryId,
      });
    }
    case "context-items": {
      const itemType = oneOf(value.itemType, ["message", "summary"] as const);
      const messageIdentitySha256 = value.messageIdentitySha256 === null
        ? null
        : assertSha256(value.messageIdentitySha256);
      const summaryId = value.summaryId === null ? null : nonemptyString(value.summaryId);
      if (
        (itemType === "message" && (messageIdentitySha256 === null || summaryId !== null)) ||
        (itemType === "summary" && (summaryId === null || messageIdentitySha256 !== null))
      ) malformed({ domain });
      return deepFreeze({
        conversationIdentitySha256: assertSha256(value.conversationIdentitySha256),
        ordinal: normalizeNonnegativeInt4(value.ordinal, mode),
        itemType,
        messageIdentitySha256,
        summaryId,
        createdAt: normalizeTimestamp(value.createdAt as PortableRawTimestamp) as PortableTimestamp,
      });
    }
    case "promoted-memories":
      return deepFreeze({
        memoryId: nonemptyString(value.memoryId),
        content: portableString(value.content),
        metadata: cloneCanonicalJsonObject(value.metadata),
        sourceProjectId: nullableString(value.sourceProjectId),
        sourceSummaryId: nullableString(value.sourceSummaryId),
        sessionId: nullableString(value.sessionId),
        depth: normalizeNonnegativeInt4(value.depth, mode),
        confidence: finiteNumber(value.confidence, 0, 1),
        createdAt: normalizeTimestamp(value.createdAt as PortableRawTimestamp) as PortableTimestamp,
        archivedAt: nullableTimestamp(value.archivedAt),
      });
    case "promoted-memory-tags":
      return deepFreeze({
        memoryId: nonemptyString(value.memoryId),
        ordinal: normalizeNonnegativeInt4(value.ordinal, mode),
        tag: portableString(value.tag),
      });
    case "recall-surfacings":
      return deepFreeze({
        memoryId: nonemptyString(value.memoryId),
        sessionId: nullableString(value.sessionId),
        surfacedAt: normalizeTimestamp(value.surfacedAt as PortableRawTimestamp) as PortableTimestamp,
        occurrenceOrdinal: normalizeNonnegativeSafeInteger(value.occurrenceOrdinal, mode),
      });
    case "redaction-counters":
      return deepFreeze({
        category: oneOf(value.category, ["built_in", "global", "project", "gitleaks"] as const),
        count: normalizeNonnegativeInt64(value.count, mode),
      });
    case "session-ingest":
      return deepFreeze({
        sessionId: nonemptyString(value.sessionId),
        messageCount: normalizeNonnegativeInt64(value.messageCount, mode),
        completedAt: normalizeTimestamp(value.completedAt as PortableRawTimestamp) as PortableTimestamp,
      });
    case "session-instructions":
      return deepFreeze({
        machineIdentityKey: nonemptyString(value.machineIdentityKey),
        scopeHash: assertSha256(value.scopeHash),
        clientName: oneOf(value.clientName, ["claude", "codex"] as const),
        sessionId: nonemptyString(value.sessionId),
        worktreePath: nonemptyString(value.worktreePath),
        cwdPath: nonemptyString(value.cwdPath),
        content: portableString(value.content),
        contentHash: assertSha256(value.contentHash),
        updatedAt: normalizeTimestamp(value.updatedAt as PortableRawTimestamp) as PortableTimestamp,
      });
    case "native-transcripts":
      return deepFreeze({
        machineIdentityKey: nonemptyString(value.machineIdentityKey),
        clientName: nonemptyString(value.clientName),
        formatName: nonemptyString(value.formatName),
        formatVersion: nonemptyString(value.formatVersion),
        nativeSessionId: nonemptyString(value.nativeSessionId),
        sourceLocator: nonemptyString(value.sourceLocator),
        sourceOrdinal: normalizeNonnegativeInt64(value.sourceOrdinal, mode),
        observedAt: normalizeTimestamp(value.observedAt as PortableRawTimestamp) as PortableTimestamp,
        ingestedAt: normalizeTimestamp(value.ingestedAt as PortableRawTimestamp) as PortableTimestamp,
        scrubberVersion: nonemptyString(value.scrubberVersion),
        contentSha256: assertSha256(value.contentSha256),
        ingestKey: assertSha256(value.ingestKey),
        nativePayload: cloneCanonicalJsonObjectOrArray(value.nativePayload),
      });
    case "native-transcript-message-links":
      return deepFreeze({
        machineIdentityKey: nonemptyString(value.machineIdentityKey),
        ingestKey: assertSha256(value.ingestKey),
        sourceOrdinal: normalizeNonnegativeInt4(value.sourceOrdinal, mode),
        conversationIdentitySha256: assertSha256(value.conversationIdentitySha256),
        messageIdentitySha256: assertSha256(value.messageIdentitySha256),
      });
    case "native-transcript-checkpoints":
      return deepFreeze({
        machineIdentityKey: nonemptyString(value.machineIdentityKey),
        clientName: nonemptyString(value.clientName),
        sourceLocator: nonemptyString(value.sourceLocator),
        revision: normalizeNonnegativeSafeInteger(value.revision, mode),
        lastSourceOrdinal: normalizeNonnegativeInt64(value.lastSourceOrdinal, mode),
        importedCount: normalizeNonnegativeInt64(value.importedCount, mode),
        skippedCount: normalizeNonnegativeInt64(value.skippedCount, mode),
        quarantinedCount: normalizeNonnegativeInt64(value.quarantinedCount, mode),
        checkpoint: cloneCanonicalJsonObject(value.checkpoint),
        updatedAt: normalizeTimestamp(value.updatedAt as PortableRawTimestamp) as PortableTimestamp,
      });
    case "passive-events":
      return deepFreeze({
        machineIdentityKey: nonemptyString(value.machineIdentityKey),
        eventId: assertUuid(value.eventId),
        eventVersion: normalizePositiveInt4(value.eventVersion, mode),
        machineSequence: normalizeNonnegativeInt64(value.machineSequence, mode),
        eventType: nonemptyString(value.eventType),
        sessionId: nonemptyString(value.sessionId),
        sessionSequence: normalizeNonnegativeSafeInteger(value.sessionSequence, mode),
        category: nonemptyString(value.category),
        data: portableString(value.data),
        priority: normalizeSignedSafeInteger(value.priority, mode),
        sourceHook: nonemptyString(value.sourceHook),
        createdAt: normalizeTimestamp(value.createdAt as PortableRawTimestamp) as PortableTimestamp,
        disposition: oneOf(value.disposition, ["pending", "applied", "quarantined"] as const),
      });
  }
}

function identitySha256(domain: PortableDomain, logicalKey: readonly PortableOrderScalar[]): string {
  return canonicalSha256([PORTABLE_RECORD_IDENTITY_TAG, domain, logicalKey]);
}

function dependency(domain: PortableDomain, logicalKey: readonly PortableOrderScalar[]): PortableDependency {
  return deepFreeze({ domain, identitySha256: identitySha256(domain, logicalKey) });
}

function directDependency(domain: PortableDomain, digest: string): PortableDependency {
  return deepFreeze({ domain, identitySha256: assertSha256(digest) });
}

function sortDependencies(dependencies: readonly PortableDependency[]): readonly PortableDependency[] {
  const sorted = [...dependencies].sort((left, right) => {
    const domainComparison = PORTABLE_RECORD_DOMAIN_ORDER.indexOf(left.domain)
      - PORTABLE_RECORD_DOMAIN_ORDER.indexOf(right.domain);
    return domainComparison === 0
      ? Buffer.from(left.identitySha256, "hex").compare(Buffer.from(right.identitySha256, "hex"))
      : domainComparison;
  });
  return deepFreeze(sorted);
}

function projectDependency(evidence: ConstructionEvidence): PortableDependency {
  return directDependency("project", evidence.projectIdentitySha256 as string);
}

function normalizeConversationOrder(value: unknown, mode: IntegerInputMode): CanonicalConversationOrder {
  const elements = plainDenseArrayElements(value);
  if (elements.length !== 6) malformed();
  return deepFreeze([
    nonemptyString(elements[0]),
    nullableString(elements[1]),
    nullableTimestamp(elements[2]),
    normalizeTimestamp(elements[3] as PortableRawTimestamp) as PortableTimestamp,
    normalizeTimestamp(elements[4] as PortableRawTimestamp) as PortableTimestamp,
    normalizeNonnegativeSafeInteger(elements[5], mode),
  ] as const);
}

function normalizeMessageOrder(value: unknown, mode: IntegerInputMode): CanonicalMessageOrder {
  const elements = plainDenseArrayElements(value);
  if (elements.length !== 7) malformed();
  const conversation = normalizeConversationOrder(elements.slice(0, 6), mode);
  return deepFreeze([...conversation, normalizeNonnegativeInt64(elements[6], mode)] as CanonicalMessageOrder);
}

function conversationFingerprintFromOrder(order: CanonicalConversationOrder): string {
  return canonicalSha256([PORTABLE_CONVERSATION_VALUE_TAG, ...order.slice(0, 5)]);
}

function conversationIdentityFromOrder(order: CanonicalConversationOrder): string {
  return identitySha256("conversations", [conversationFingerprintFromOrder(order), order[5]]);
}

function messageIdentityFromOrder(order: CanonicalMessageOrder): string {
  return identitySha256("messages", [
    conversationIdentityFromOrder(order.slice(0, 6) as unknown as CanonicalConversationOrder),
    order[6],
  ]);
}

function expectContextObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  return snapshotExactObject(value, keys);
}

function projectEvidence(context: unknown): ConstructionEvidence {
  const object = expectContextObject(context, ["projectIdentity"]);
  const identity = normalizeProjectIdentity(object.projectIdentity);
  return { projectIdentitySha256: identitySha256("project", [identity.scope, identity.projectId]) };
}

function evidenceFromContext(domain: PortableDomain, context: unknown): ConstructionEvidence {
  switch (domain) {
    case "project-aliases":
    case "conversations":
    case "promoted-memories":
    case "recall-surfacings":
    case "redaction-counters":
    case "session-ingest":
    case "session-instructions":
    case "native-transcript-checkpoints":
    case "passive-events":
      return projectEvidence(context);
    case "messages":
    case "context-items": {
      const object = expectContextObject(context, ["conversationOrder"]);
      return { conversationOrder: normalizeConversationOrder(object.conversationOrder, "raw") };
    }
    case "message-parts": {
      const object = expectContextObject(context, ["messageOrder"]);
      return { messageOrder: normalizeMessageOrder(object.messageOrder, "raw") };
    }
    case "native-transcripts": {
      const object = expectContextObject(context, [
        "projectIdentity",
        "canonicalPayloadBytes",
        "canonicalMetadataBytes",
      ]);
      const identity = normalizeProjectIdentity(object.projectIdentity);
      return {
        projectIdentitySha256: identitySha256("project", [identity.scope, identity.projectId]),
        canonicalPayloadBytes: validateOrdinal(object.canonicalPayloadBytes),
        canonicalMetadataBytes: validateOrdinal(object.canonicalMetadataBytes),
      };
    }
    default:
      if (context !== null) malformed();
      return {};
  }
}

function buildRecordShape(
  domain: PortableDomain,
  ordinal: number,
  value: PortableRecordValue,
  evidence: ConstructionEvidence,
): PortableRecordShape {
  switch (domain) {
    case "machines": {
      const item = value as PortableRecordValueByDomain["machines"];
      return { domain, ordinal, order: [item.identityKey], logicalKey: [item.identityKey], dependencies: [], value };
    }
    case "project": {
      const item = value as PortableRecordValueByDomain["project"];
      const key = [item.identity.scope, item.identity.projectId] as const;
      return { domain, ordinal, order: key, logicalKey: key, dependencies: [], value };
    }
    case "project-aliases": {
      const item = value as PortableRecordValueByDomain["project-aliases"];
      return {
        domain, ordinal,
        order: [item.machineIdentityKey, item.normalizedPath, item.path],
        logicalKey: [item.machineIdentityKey, item.normalizedPath],
        dependencies: sortDependencies([
          dependency("machines", [item.machineIdentityKey]),
          projectDependency(evidence),
        ]),
        value,
      };
    }
    case "conversations": {
      const item = value as PortableRecordValueByDomain["conversations"];
      return {
        domain, ordinal,
        order: [item.sessionId, item.title, item.bootstrappedAt, item.createdAt, item.updatedAt, item.occurrenceOrdinal],
        logicalKey: [item.conversationFingerprint, item.occurrenceOrdinal],
        dependencies: [projectDependency(evidence)],
        value,
      };
    }
    case "messages": {
      const item = value as PortableRecordValueByDomain["messages"];
      const parent = evidence.conversationOrder as CanonicalConversationOrder;
      if (conversationIdentityFromOrder(parent) !== item.conversationIdentitySha256) malformed({ domain });
      return {
        domain, ordinal,
        order: [...parent, item.seq],
        logicalKey: [item.conversationIdentitySha256, item.seq],
        dependencies: [directDependency("conversations", item.conversationIdentitySha256)],
        value,
      };
    }
    case "message-parts": {
      const item = value as PortableRecordValueByDomain["message-parts"];
      const parent = evidence.messageOrder as CanonicalMessageOrder;
      if (messageIdentityFromOrder(parent) !== item.messageIdentitySha256) malformed({ domain });
      return {
        domain, ordinal,
        order: [...parent, item.ordinal],
        logicalKey: [item.messageIdentitySha256, item.ordinal],
        dependencies: [directDependency("messages", item.messageIdentitySha256)],
        value,
      };
    }
    case "large-files": {
      const item = value as PortableRecordValueByDomain["large-files"];
      return {
        domain, ordinal, order: [item.fileId], logicalKey: [item.fileId],
        dependencies: [directDependency("conversations", item.conversationIdentitySha256)], value,
      };
    }
    case "summaries": {
      const item = value as PortableRecordValueByDomain["summaries"];
      return {
        domain, ordinal, order: [item.summaryId], logicalKey: [item.summaryId],
        dependencies: [directDependency("conversations", item.conversationIdentitySha256)], value,
      };
    }
    case "summary-file-links": {
      const item = value as PortableRecordValueByDomain["summary-file-links"];
      const key = [item.summaryId, item.ordinal] as const;
      return { domain, ordinal, order: key, logicalKey: key, dependencies: [dependency("summaries", [item.summaryId])], value };
    }
    case "summary-message-links": {
      const item = value as PortableRecordValueByDomain["summary-message-links"];
      return {
        domain, ordinal,
        order: [item.summaryId, item.messageIdentitySha256, item.ordinal],
        logicalKey: [item.summaryId, item.messageIdentitySha256],
        dependencies: sortDependencies([
          dependency("summaries", [item.summaryId]),
          directDependency("messages", item.messageIdentitySha256),
        ]),
        value,
      };
    }
    case "summary-parent-links": {
      const item = value as PortableRecordValueByDomain["summary-parent-links"];
      return {
        domain, ordinal,
        order: [item.summaryId, item.parentSummaryId, item.ordinal],
        logicalKey: [item.summaryId, item.parentSummaryId],
        dependencies: sortDependencies([
          dependency("summaries", [item.summaryId]),
          dependency("summaries", [item.parentSummaryId]),
        ]),
        value,
      };
    }
    case "context-items": {
      const item = value as PortableRecordValueByDomain["context-items"];
      const parent = evidence.conversationOrder as CanonicalConversationOrder;
      if (conversationIdentityFromOrder(parent) !== item.conversationIdentitySha256) malformed({ domain });
      const target = item.itemType === "message"
        ? directDependency("messages", item.messageIdentitySha256 as string)
        : dependency("summaries", [item.summaryId as string]);
      return {
        domain, ordinal,
        order: [...parent, item.ordinal],
        logicalKey: [item.conversationIdentitySha256, item.ordinal],
        dependencies: sortDependencies([
          directDependency("conversations", item.conversationIdentitySha256),
          target,
        ]),
        value,
      };
    }
    case "promoted-memories": {
      const item = value as PortableRecordValueByDomain["promoted-memories"];
      return {
        domain, ordinal, order: [item.memoryId], logicalKey: [item.memoryId],
        dependencies: [projectDependency(evidence)], value,
      };
    }
    case "promoted-memory-tags": {
      const item = value as PortableRecordValueByDomain["promoted-memory-tags"];
      const key = [item.memoryId, item.ordinal] as const;
      return {
        domain, ordinal, order: key, logicalKey: key,
        dependencies: [dependency("promoted-memories", [item.memoryId])], value,
      };
    }
    case "recall-surfacings": {
      const item = value as PortableRecordValueByDomain["recall-surfacings"];
      const key = [item.memoryId, item.sessionId, item.surfacedAt, item.occurrenceOrdinal] as const;
      return { domain, ordinal, order: key, logicalKey: key, dependencies: [projectDependency(evidence)], value };
    }
    case "redaction-counters": {
      const item = value as PortableRecordValueByDomain["redaction-counters"];
      return {
        domain, ordinal, order: [item.category], logicalKey: [item.category],
        dependencies: [projectDependency(evidence)], value,
      };
    }
    case "session-ingest": {
      const item = value as PortableRecordValueByDomain["session-ingest"];
      return {
        domain, ordinal, order: [item.sessionId], logicalKey: [item.sessionId],
        dependencies: [projectDependency(evidence)], value,
      };
    }
    case "session-instructions": {
      const item = value as PortableRecordValueByDomain["session-instructions"];
      const key = [item.machineIdentityKey, item.scopeHash] as const;
      return {
        domain, ordinal, order: key, logicalKey: key,
        dependencies: sortDependencies([
          dependency("machines", [item.machineIdentityKey]),
          projectDependency(evidence),
        ]),
        value,
      };
    }
    case "native-transcripts": {
      const item = value as PortableRecordValueByDomain["native-transcripts"];
      const payloadBytes = Buffer.byteLength(canonicalJson(item.nativePayload), "utf8");
      const metadata = { ...item } as Record<string, unknown>;
      delete metadata.nativePayload;
      const metadataBytes = Buffer.byteLength(canonicalJson(metadata), "utf8");
      if (
        (evidence.canonicalPayloadBytes !== undefined && evidence.canonicalPayloadBytes !== payloadBytes) ||
        (evidence.canonicalMetadataBytes !== undefined && evidence.canonicalMetadataBytes !== metadataBytes)
      ) malformed({ domain });
      if (Math.max(
        payloadBytes / MAX_NATIVE_PAYLOAD_BYTES,
        metadataBytes / PORTABLE_LIMITS.maxControlBytes,
      ) > 1) {
        fail("record-unrepresentable", { domain });
      }
      const key = [item.machineIdentityKey, item.ingestKey] as const;
      return {
        domain, ordinal, order: key, logicalKey: key,
        dependencies: sortDependencies([
          dependency("machines", [item.machineIdentityKey]),
          projectDependency(evidence),
        ]),
        value,
      };
    }
    case "native-transcript-message-links": {
      const item = value as PortableRecordValueByDomain["native-transcript-message-links"];
      const key = [item.machineIdentityKey, item.ingestKey, item.sourceOrdinal] as const;
      return {
        domain, ordinal, order: key, logicalKey: key,
        dependencies: sortDependencies([
          dependency("native-transcripts", [item.machineIdentityKey, item.ingestKey]),
          directDependency("messages", item.messageIdentitySha256),
        ]),
        value,
      };
    }
    case "native-transcript-checkpoints": {
      const item = value as PortableRecordValueByDomain["native-transcript-checkpoints"];
      const key = [item.machineIdentityKey, item.clientName, item.sourceLocator] as const;
      return {
        domain, ordinal, order: key, logicalKey: key,
        dependencies: sortDependencies([
          dependency("machines", [item.machineIdentityKey]),
          projectDependency(evidence),
        ]),
        value,
      };
    }
    case "passive-events": {
      const item = value as PortableRecordValueByDomain["passive-events"];
      return {
        domain, ordinal,
        order: [item.machineIdentityKey, item.eventId, item.machineSequence],
        logicalKey: [item.machineIdentityKey, item.eventId],
        dependencies: sortDependencies([
          dependency("machines", [item.machineIdentityKey]),
          projectDependency(evidence),
        ]),
        value,
      };
    }
  }
}

function canonicalRecord(shape: PortableRecordShape): PortableRecord {
  const order = shape.order.map((scalar) => isPlainObject(scalar)
    ? Object.freeze({ $integer: scalar.$integer }) as PortableIntegerValue
    : scalar);
  const withoutRecordSha256 = {
    version: 1,
    domain: shape.domain,
    domainVersion: 1,
    ordinal: shape.ordinal,
    order,
    identitySha256: identitySha256(shape.domain, shape.logicalKey),
    dependencies: shape.dependencies,
    value: shape.value,
  } as const;
  const record = deepFreeze({
    ...withoutRecordSha256,
    recordSha256: sha256(Buffer.from(canonicalEnvelopeJson(withoutRecordSha256), "utf8")),
  }) as PortableRecord;
  if (Buffer.byteLength(canonicalEnvelopeJson(record), "utf8") + 1 > PORTABLE_LIMITS.maxRecordBytes) {
    fail("record-unrepresentable", { domain: shape.domain, ordinal: shape.ordinal });
  }
  return record;
}

function parseDependencies(value: unknown): readonly PortableDependency[] {
  const items = plainDenseArrayElements(value);
  const dependencies = new Array<PortableDependency>(items.length);
  for (let index = 0; index < items.length; index += 1) {
    const item = snapshotExactObject(items[index], ["domain", "identitySha256"]);
    if (typeof item.domain !== "string" || !PORTABLE_RECORD_DOMAIN_ORDER.includes(item.domain as PortableDomain)) {
      malformed();
    }
    dependencies[index] = deepFreeze({
      domain: item.domain as PortableDomain,
      identitySha256: assertSha256(item.identitySha256),
    });
  }
  return dependencies;
}

function projectDigestFromWire(dependencies: readonly PortableDependency[]): string {
  const projects = dependencies.filter((item) => item.domain === "project");
  if (projects.length !== 1) malformed();
  return projects[0].identitySha256;
}

function evidenceFromWire(
  domain: PortableDomain,
  orderValue: unknown,
  dependencyValue: unknown,
): ConstructionEvidence {
  const dependencies = parseDependencies(dependencyValue);
  switch (domain) {
    case "project-aliases":
    case "conversations":
    case "promoted-memories":
    case "recall-surfacings":
    case "redaction-counters":
    case "session-ingest":
    case "session-instructions":
    case "native-transcript-checkpoints":
    case "passive-events":
      return { projectIdentitySha256: projectDigestFromWire(dependencies) };
    case "messages":
    case "context-items": {
      const order = plainDenseArrayElements(orderValue);
      if (order.length !== 7) malformed();
      return { conversationOrder: normalizeConversationOrder(order.slice(0, 6), "wire") };
    }
    case "message-parts": {
      const order = plainDenseArrayElements(orderValue);
      if (order.length !== 8) malformed();
      return { messageOrder: normalizeMessageOrder(order.slice(0, 7), "wire") };
    }
    case "native-transcripts":
      return { projectIdentitySha256: projectDigestFromWire(dependencies) };
    default:
      return {};
  }
}

function validatePortableRecordEnvelope(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainObject(value) || !exactKeys(value, PORTABLE_RECORD_ENVELOPE_KEYS)) malformed();
}

function snapshotPortableRecordEnvelope(value: unknown): Record<string, unknown> {
  return snapshotExactObject(value, PORTABLE_RECORD_ENVELOPE_KEYS);
}

function parseJsonRecord(bytes: Uint8Array): Record<string, unknown> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > PORTABLE_LIMITS.maxRecordBytes) {
    fail(bytes instanceof Uint8Array ? "record-unrepresentable" : "malformed-record");
  }
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0x0a) malformed();
  if (bytes.byteLength > 1 && bytes[bytes.byteLength - 2] === 0x0a) malformed();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, -1));
  } catch {
    malformed();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    malformed();
  }
  if (Buffer.compare(Buffer.from(text, "utf8"), Buffer.from(canonicalEnvelopeJson(parsed), "utf8")) !== 0) {
    malformed();
  }
  validatePortableRecordEnvelope(parsed);
  return parsed;
}

export function createPortableRecord<D extends PortableDomain>(
  input: PortableRecordInput<D>,
): PortableRecord<D>;
export function createPortableRecord(input: PortableRecordInput): PortableRecord;
export function createPortableRecord(input: PortableRecordInput): PortableRecord {
  const snapshot = snapshotExactObject(input, ["domain", "ordinal", "value", "context"]);
  const domain = assertDomain(snapshot.domain);
  const ordinal = validateOrdinal(snapshot.ordinal);
  const value = normalizeDomainValue(domain, snapshot.value, "raw");
  const evidence = evidenceFromContext(domain, snapshot.context);
  return canonicalRecord(buildRecordShape(domain, ordinal, value, evidence));
}

export function serializePortableRecord(record: PortableRecord): Uint8Array {
  const validated = validatePortableRecord(record);
  const canonical = canonicalEnvelopeJson(validated);
  const bytes = Buffer.from(`${canonical}\n`, "utf8");
  return bytes;
}

export function parsePortableRecord(bytes: Uint8Array): PortableRecord {
  const parsed = parseJsonRecord(bytes);
  return validatePortableRecord(parsed);
}

function validatePortableRecord(parsed: unknown): PortableRecord {
  const envelope = snapshotPortableRecordEnvelope(parsed);
  if (envelope.version !== 1 || envelope.domainVersion !== 1) fail("unsupported-version");
  const domain = assertDomain(envelope.domain);
  const ordinal = validateOrdinal(envelope.ordinal);
  const value = normalizeDomainValue(domain, envelope.value, "wire");
  const evidence = evidenceFromWire(domain, envelope.order, envelope.dependencies);
  const record = canonicalRecord(buildRecordShape(domain, ordinal, value, evidence));
  if (canonicalJson(envelope.order) !== canonicalJson(record.order)) malformed();
  if (envelope.identitySha256 !== record.identitySha256) malformed();
  if (canonicalJson(envelope.dependencies) !== canonicalJson(record.dependencies)) malformed();
  if (canonicalEnvelopeJson(envelope) !== canonicalEnvelopeJson(record)) malformed();
  return record;
}
