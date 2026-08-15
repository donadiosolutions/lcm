import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PORTABLE_LIMITS,
  PORTABLE_RECORD_DOMAIN_ORDER,
  PORTABLE_RECORD_SCHEMA_DESCRIPTOR,
  PORTABLE_RECORD_SCHEMA_SHA256,
  PortableStreamError,
  canonicalJson,
  canonicalJsonBytes,
  canonicalSha256,
  comparePortableOrder,
  createPortableRecord,
  parsePortableRecord,
  serializePortableRecord,
  sha256,
  validatePortableRecordSchemaDescriptor,
} from "../../src/storage/portable-record.js";

const MACHINE_IDENTITY = "machine-identity";
const PROJECT_ID = "a".repeat(64);
const MESSAGE_ID = "c".repeat(64);
const SUMMARY_ID = "summary-1";
const HASH = "d".repeat(64);
const TIMESTAMP = "2026-08-13T12:34:56.123456Z";
const SESSION_ID = "session-1";
const CONVERSATION_TITLE = "Conversation";
const CONVERSATION_CREATED_AT = TIMESTAMP;
const CONVERSATION_UPDATED_AT = TIMESTAMP;
const CONVERSATION_BOOTSTRAPPED_AT = null;

const integer = (value: string | number | bigint) => ({ $integer: String(value) });

function referenceCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(referenceCanonicalJson).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${referenceCanonicalJson(object[key])}`)
    .join(",")}}`;
}

const independentlyHashed = (value: unknown) => createHash("sha256")
  .update(Buffer.from(referenceCanonicalJson(value), "utf8"))
  .digest("hex");

const projectIdentity = { scope: "local" as const, projectId: PROJECT_ID };
const projectIdentitySha256 = independentlyHashed([
  "lcm-portable-identity-v1",
  "project",
  [projectIdentity.scope, projectIdentity.projectId],
]);
const conversationFingerprint = independentlyHashed([
  "lcm-portable-conversation-value-v1",
  SESSION_ID,
  CONVERSATION_TITLE,
  CONVERSATION_BOOTSTRAPPED_AT,
  CONVERSATION_CREATED_AT,
  CONVERSATION_UPDATED_AT,
]);
const conversationOrder = [
  SESSION_ID,
  CONVERSATION_TITLE,
  CONVERSATION_BOOTSTRAPPED_AT,
  CONVERSATION_CREATED_AT,
  CONVERSATION_UPDATED_AT,
  0,
] as const;
const canonicalConversationOrder = [
  SESSION_ID,
  CONVERSATION_TITLE,
  CONVERSATION_BOOTSTRAPPED_AT,
  CONVERSATION_CREATED_AT,
  CONVERSATION_UPDATED_AT,
  integer(0),
] as const;
const conversationIdentitySha256 = independentlyHashed([
  "lcm-portable-identity-v1",
  "conversations",
  [conversationFingerprint, integer(0)],
]);
const messageOrder = [...conversationOrder, 0] as const;
const canonicalMessageOrder = [...canonicalConversationOrder, integer(0)] as const;
const messageIdentitySha256 = independentlyHashed([
  "lcm-portable-identity-v1",
  "messages",
  [conversationIdentitySha256, integer(0)],
]);

const base = {
  machine: { identityKey: MACHINE_IDENTITY, machineId: null },
  project: { identity: projectIdentity },
};

const contexts: Record<string, unknown> = {
  machines: null,
  project: null,
  "project-aliases": { projectIdentity },
  conversations: { projectIdentity },
  messages: { conversationOrder },
  "message-parts": { messageOrder },
  "large-files": null,
  summaries: null,
  "summary-file-links": null,
  "summary-message-links": null,
  "summary-parent-links": null,
  "context-items": { conversationOrder },
  "promoted-memories": { projectIdentity },
  "promoted-memory-tags": null,
  "recall-surfacings": { projectIdentity },
  "redaction-counters": { projectIdentity },
  "session-ingest": { projectIdentity },
  "session-instructions": { projectIdentity },
  "native-transcripts": null,
  "native-transcript-message-links": null,
  "native-transcript-checkpoints": { projectIdentity },
  "passive-events": { projectIdentity },
};

const representativeValues: Record<string, Record<string, unknown>> = {
  machines: base.machine,
  project: base.project,
  "project-aliases": {
    machineIdentityKey: MACHINE_IDENTITY,
    path: "/repo/project",
    normalizedPath: "/repo/project",
  },
  conversations: {
    conversationFingerprint,
    occurrenceOrdinal: 0,
    sessionId: SESSION_ID,
    createdAt: CONVERSATION_CREATED_AT,
    title: CONVERSATION_TITLE,
    bootstrappedAt: CONVERSATION_BOOTSTRAPPED_AT,
    updatedAt: CONVERSATION_UPDATED_AT,
  },
  messages: {
    conversationIdentitySha256,
    seq: 0,
    role: "user",
    content: "hello",
    tokenCount: 1,
    createdAt: TIMESTAMP,
  },
  "message-parts": {
    messageIdentitySha256,
    partId: "part-1",
    sessionId: "session-1",
    partType: "text",
    ordinal: 0,
    textContent: "hello",
    isIgnored: false,
    isSynthetic: false,
    toolCallId: null,
    toolName: null,
    toolStatus: null,
    toolInput: null,
    toolOutput: null,
    toolError: null,
    toolTitle: null,
    patchHash: null,
    patchFiles: null,
    fileMime: null,
    fileName: null,
    fileUrl: null,
    subtaskPrompt: null,
    subtaskDescription: null,
    subtaskAgent: null,
    stepReason: null,
    stepCost: null,
    stepTokensIn: null,
    stepTokensOut: null,
    snapshotHash: null,
    compactionAuto: null,
    metadata: null,
  },
  "large-files": {
    fileId: "file-1",
    conversationIdentitySha256,
    fileName: "file.txt",
    mimeType: "text/plain",
    byteSize: 5,
    storageUri: "memory://file-1",
    explorationSummary: null,
    createdAt: TIMESTAMP,
  },
  summaries: {
    summaryId: SUMMARY_ID,
    conversationIdentitySha256,
    kind: "leaf",
    depth: 0,
    content: "summary",
    tokenCount: 1,
    earliestAt: null,
    latestAt: TIMESTAMP,
    descendantCount: 0,
    descendantTokenCount: 0,
    sourceMessageTokenCount: 1,
    createdAt: TIMESTAMP,
  },
  "summary-file-links": { summaryId: SUMMARY_ID, ordinal: 0, fileId: "file-1" },
  "summary-message-links": { summaryId: SUMMARY_ID, ordinal: 0, messageIdentitySha256 },
  "summary-parent-links": { summaryId: SUMMARY_ID, ordinal: 0, parentSummaryId: "summary-parent" },
  "context-items": {
    conversationIdentitySha256,
    ordinal: 0,
    itemType: "message",
    messageIdentitySha256,
    summaryId: null,
    createdAt: TIMESTAMP,
  },
  "promoted-memories": {
    memoryId: "memory-1",
    content: "remember this",
    metadata: { source: "test" },
    sourceProjectId: null,
    sourceSummaryId: null,
    sessionId: "session-1",
    depth: 0,
    confidence: 0.5,
    createdAt: TIMESTAMP,
    archivedAt: null,
  },
  "promoted-memory-tags": { memoryId: "memory-1", ordinal: 0, tag: "important" },
  "recall-surfacings": {
    memoryId: "memory-1",
    sessionId: null,
    surfacedAt: TIMESTAMP,
    occurrenceOrdinal: 0,
  },
  "redaction-counters": { category: "built_in", count: 0 },
  "session-ingest": { sessionId: SESSION_ID, messageCount: 1, completedAt: TIMESTAMP },
  "session-instructions": {
    machineIdentityKey: MACHINE_IDENTITY,
    scopeHash: HASH,
    clientName: "codex",
    sessionId: SESSION_ID,
    worktreePath: "/repo/project",
    cwdPath: "/repo/project/src",
    content: "instructions",
    contentHash: HASH,
    updatedAt: TIMESTAMP,
  },
  "native-transcripts": {
    machineIdentityKey: MACHINE_IDENTITY,
    clientName: "codex",
    formatName: "jsonl",
    formatVersion: "1",
    nativeSessionId: "native-session-1",
    sourceLocator: "/home/user/transcript.jsonl",
    sourceOrdinal: 0,
    observedAt: TIMESTAMP,
    ingestedAt: TIMESTAMP,
    scrubberVersion: "1",
    contentSha256: HASH,
    ingestKey: HASH,
    nativePayload: { role: "user", content: "hello" },
  },
  "native-transcript-message-links": {
    machineIdentityKey: MACHINE_IDENTITY,
    ingestKey: HASH,
    sourceOrdinal: 0,
    conversationIdentitySha256,
    messageIdentitySha256,
  },
  "native-transcript-checkpoints": {
    machineIdentityKey: MACHINE_IDENTITY,
    clientName: "codex",
    sourceLocator: "/home/user/transcript.jsonl",
    revision: 0,
    lastSourceOrdinal: 0,
    importedCount: 0,
    skippedCount: 0,
    quarantinedCount: 0,
    checkpoint: { last: 0 },
    updatedAt: TIMESTAMP,
  },
  "passive-events": {
    machineIdentityKey: MACHINE_IDENTITY,
    eventId: "00000000-0000-7000-8000-000000000001",
    eventVersion: 1,
    machineSequence: 0,
    eventType: "message",
    sessionId: SESSION_ID,
    sessionSequence: 0,
    category: "test",
    data: "payload",
    priority: 0,
    sourceHook: "PostToolUse",
    createdAt: TIMESTAMP,
    disposition: "pending",
  },
};

const expectedDomainSchema: Record<string, {
  logicalKey: readonly string[];
  identityOrderPrefix: readonly string[];
  order: readonly string[];
  dependencies: readonly string[];
}> = {
  machines: { logicalKey: ["identityKey"], identityOrderPrefix: ["identityKey"], order: ["identityKey"], dependencies: [] },
  project: { logicalKey: ["identity.scope", "identity.projectId"], identityOrderPrefix: ["scope", "projectId"], order: ["scope", "projectId"], dependencies: [] },
  "project-aliases": {
    logicalKey: ["machineIdentityKey", "normalizedPath"],
    identityOrderPrefix: ["machineIdentityKey", "normalizedPath"],
    order: ["machineIdentityKey", "normalizedPath", "path"],
    dependencies: ["machines", "project"],
  },
  conversations: {
    logicalKey: ["conversationFingerprint", "occurrenceOrdinal"],
    identityOrderPrefix: ["sessionId", "title", "bootstrappedAt", "createdAt", "updatedAt", "occurrenceOrdinal"],
    order: ["sessionId", "title", "bootstrappedAt", "createdAt", "updatedAt", "occurrenceOrdinal"],
    dependencies: ["project"],
  },
  messages: {
    logicalKey: ["conversationIdentitySha256", "seq"],
    identityOrderPrefix: ["sessionId", "title", "bootstrappedAt", "conversationCreatedAt", "conversationUpdatedAt", "conversationOccurrenceOrdinal", "seq"],
    order: ["sessionId", "title", "bootstrappedAt", "conversationCreatedAt", "conversationUpdatedAt", "conversationOccurrenceOrdinal", "seq"],
    dependencies: ["conversations"],
  },
  "message-parts": {
    logicalKey: ["messageIdentitySha256", "ordinal"],
    identityOrderPrefix: ["sessionId", "title", "bootstrappedAt", "conversationCreatedAt", "conversationUpdatedAt", "conversationOccurrenceOrdinal", "messageSeq", "ordinal"],
    order: ["sessionId", "title", "bootstrappedAt", "conversationCreatedAt", "conversationUpdatedAt", "conversationOccurrenceOrdinal", "messageSeq", "ordinal"],
    dependencies: ["messages"],
  },
  "large-files": { logicalKey: ["fileId"], identityOrderPrefix: ["fileId"], order: ["fileId"], dependencies: ["conversations"] },
  summaries: { logicalKey: ["summaryId"], identityOrderPrefix: ["summaryId"], order: ["summaryId"], dependencies: ["conversations"] },
  "summary-file-links": { logicalKey: ["summaryId", "ordinal"], identityOrderPrefix: ["summaryId", "ordinal"], order: ["summaryId", "ordinal"], dependencies: ["summaries"] },
  "summary-message-links": {
    logicalKey: ["summaryId", "messageIdentitySha256"],
    identityOrderPrefix: ["summaryId", "messageIdentitySha256"],
    order: ["summaryId", "messageIdentitySha256", "ordinal"],
    dependencies: ["summaries", "messages"],
  },
  "summary-parent-links": {
    logicalKey: ["summaryId", "parentSummaryId"],
    identityOrderPrefix: ["summaryId", "parentSummaryId"],
    order: ["summaryId", "parentSummaryId", "ordinal"],
    dependencies: ["summaries"],
  },
  "context-items": {
    logicalKey: ["conversationIdentitySha256", "ordinal"],
    identityOrderPrefix: ["sessionId", "title", "bootstrappedAt", "conversationCreatedAt", "conversationUpdatedAt", "conversationOccurrenceOrdinal", "ordinal"],
    order: ["sessionId", "title", "bootstrappedAt", "conversationCreatedAt", "conversationUpdatedAt", "conversationOccurrenceOrdinal", "ordinal"],
    dependencies: ["conversations", "messages|summaries"],
  },
  "promoted-memories": { logicalKey: ["memoryId"], identityOrderPrefix: ["memoryId"], order: ["memoryId"], dependencies: ["project"] },
  "promoted-memory-tags": { logicalKey: ["memoryId", "ordinal"], identityOrderPrefix: ["memoryId", "ordinal"], order: ["memoryId", "ordinal"], dependencies: ["promoted-memories"] },
  "recall-surfacings": {
    logicalKey: ["memoryId", "sessionId", "surfacedAt", "occurrenceOrdinal"],
    identityOrderPrefix: ["memoryId", "sessionId", "surfacedAt", "occurrenceOrdinal"],
    order: ["memoryId", "sessionId", "surfacedAt", "occurrenceOrdinal"],
    dependencies: ["project"],
  },
  "redaction-counters": { logicalKey: ["category"], identityOrderPrefix: ["category"], order: ["category"], dependencies: ["project"] },
  "session-ingest": { logicalKey: ["sessionId"], identityOrderPrefix: ["sessionId"], order: ["sessionId"], dependencies: ["project"] },
  "session-instructions": {
    logicalKey: ["machineIdentityKey", "scopeHash"],
    identityOrderPrefix: ["machineIdentityKey", "scopeHash"],
    order: ["machineIdentityKey", "scopeHash"],
    dependencies: ["machines", "project"],
  },
  "native-transcripts": {
    logicalKey: ["machineIdentityKey", "ingestKey"],
    identityOrderPrefix: ["machineIdentityKey", "ingestKey"],
    order: ["machineIdentityKey", "ingestKey"],
    dependencies: ["machines", "project"],
  },
  "native-transcript-message-links": {
    logicalKey: ["machineIdentityKey", "ingestKey", "sourceOrdinal"],
    identityOrderPrefix: ["machineIdentityKey", "ingestKey", "sourceOrdinal"],
    order: ["machineIdentityKey", "ingestKey", "sourceOrdinal"],
    dependencies: ["native-transcripts", "messages"],
  },
  "native-transcript-checkpoints": {
    logicalKey: ["machineIdentityKey", "clientName", "sourceLocator"],
    identityOrderPrefix: ["machineIdentityKey", "clientName", "sourceLocator"],
    order: ["machineIdentityKey", "clientName", "sourceLocator"],
    dependencies: ["machines", "project"],
  },
  "passive-events": {
    logicalKey: ["machineIdentityKey", "eventId"],
    identityOrderPrefix: ["machineIdentityKey", "eventId"],
    order: ["machineIdentityKey", "eventId", "machineSequence"],
    dependencies: ["machines", "project"],
  },
};

const expectedConstructionContract: Record<string, Readonly<{
  constructionContext: readonly string[];
  contextValidation: readonly string[];
}>> = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [domain, {
  constructionContext: [],
  contextValidation: ["exact-null"],
}])) as never;

Object.assign(expectedConstructionContract, {
  "project-aliases": {
    constructionContext: ["projectIdentity"],
    contextValidation: ["exact-object", "derive-project-dependency"],
  },
  conversations: {
    constructionContext: ["projectIdentity"],
    contextValidation: ["exact-object", "derive-project-dependency", "bind-conversation-fingerprint"],
  },
  messages: {
    constructionContext: ["conversationOrder"],
    contextValidation: ["exact-object", "normalize-conversation-order", "bind-conversation-identity"],
  },
  "message-parts": {
    constructionContext: ["messageOrder"],
    contextValidation: ["exact-object", "normalize-message-order", "bind-message-identity"],
  },
  "context-items": {
    constructionContext: ["conversationOrder"],
    contextValidation: ["exact-object", "normalize-conversation-order", "bind-conversation-identity"],
  },
  "promoted-memories": {
    constructionContext: ["projectIdentity"],
    contextValidation: ["exact-object", "derive-project-dependency"],
  },
  "recall-surfacings": {
    constructionContext: ["projectIdentity"],
    contextValidation: ["exact-object", "derive-project-dependency"],
  },
  "redaction-counters": {
    constructionContext: ["projectIdentity"],
    contextValidation: ["exact-object", "derive-project-dependency"],
  },
  "session-ingest": {
    constructionContext: ["projectIdentity"],
    contextValidation: ["exact-object", "derive-project-dependency"],
  },
  "session-instructions": {
    constructionContext: ["projectIdentity"],
    contextValidation: ["exact-object", "derive-project-dependency"],
  },
  "native-transcripts": {
    constructionContext: ["projectIdentity", "canonicalPayloadBytes", "canonicalMetadataBytes"],
    contextValidation: [
      "exact-object",
      "derive-project-dependency",
      "match-canonical-payload-bytes",
      "match-canonical-metadata-bytes",
      "enforce-native-byte-limits",
    ],
  },
  "native-transcript-checkpoints": {
    constructionContext: ["projectIdentity"],
    contextValidation: ["exact-object", "derive-project-dependency"],
  },
  "passive-events": {
    constructionContext: ["projectIdentity"],
    contextValidation: ["exact-object", "derive-project-dependency"],
  },
});

const expectedConversationClosureDescriptor = {
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
} as const;

const nativeContext = (value: Record<string, unknown>) => ({
  projectIdentity,
  canonicalPayloadBytes: Buffer.byteLength(referenceCanonicalJson(value.nativePayload), "utf8"),
  canonicalMetadataBytes: Buffer.byteLength(
    referenceCanonicalJson({
      machineIdentityKey: value.machineIdentityKey,
      clientName: value.clientName,
      formatName: value.formatName,
      formatVersion: value.formatVersion,
      nativeSessionId: value.nativeSessionId,
      sourceLocator: value.sourceLocator,
      sourceOrdinal: integer(value.sourceOrdinal as string | number | bigint),
      observedAt: value.observedAt,
      ingestedAt: value.ingestedAt,
      scrubberVersion: value.scrubberVersion,
      contentSha256: value.contentSha256,
      ingestKey: value.ingestKey,
    }),
    "utf8",
  ),
});

const DEFAULT_CONTEXT = Symbol("default portable construction context");

const create = (
  domain: string,
  value: Record<string, unknown>,
  ordinal = 0,
  context: unknown = DEFAULT_CONTEXT,
) => {
  const effectiveContext = context === DEFAULT_CONTEXT
    ? domain === "native-transcripts" ? nativeContext(value) : contexts[domain]
    : context;
  return createPortableRecord({ domain, value, ordinal, context: effectiveContext } as never);
};

const identitySha256 = (domain: string, logicalKey: readonly unknown[]) => independentlyHashed([
  "lcm-portable-identity-v1",
  domain,
  logicalKey,
]);

const dependency = (domain: string, logicalKey: readonly unknown[]) => ({
  domain,
  identitySha256: identitySha256(domain, logicalKey),
});

const sortDependencies = (
  dependencies: readonly Readonly<{ domain: string; identitySha256: string }>[],
) => [...dependencies].sort((left, right) => {
  const domainOrder = PORTABLE_RECORD_DOMAIN_ORDER.indexOf(left.domain as never)
    - PORTABLE_RECORD_DOMAIN_ORDER.indexOf(right.domain as never);
  return domainOrder === 0
    ? Buffer.from(left.identitySha256, "hex").compare(Buffer.from(right.identitySha256, "hex"))
    : domainOrder;
});

const expectedRecordShapes: Record<string, Readonly<{
  order: readonly unknown[];
  logicalKey: readonly unknown[];
  dependencies: readonly Readonly<{ domain: string; identitySha256: string }>[];
}>> = {
  machines: {
    order: [MACHINE_IDENTITY],
    logicalKey: [MACHINE_IDENTITY],
    dependencies: [],
  },
  project: {
    order: ["local", PROJECT_ID],
    logicalKey: ["local", PROJECT_ID],
    dependencies: [],
  },
  "project-aliases": {
    order: [MACHINE_IDENTITY, "/repo/project", "/repo/project"],
    logicalKey: [MACHINE_IDENTITY, "/repo/project"],
    dependencies: sortDependencies([
      dependency("machines", [MACHINE_IDENTITY]),
      dependency("project", ["local", PROJECT_ID]),
    ]),
  },
  conversations: {
    order: canonicalConversationOrder,
    logicalKey: [conversationFingerprint, integer(0)],
    dependencies: [dependency("project", ["local", PROJECT_ID])],
  },
  messages: {
    order: canonicalMessageOrder,
    logicalKey: [conversationIdentitySha256, integer(0)],
    dependencies: [dependency("conversations", [conversationFingerprint, integer(0)])],
  },
  "message-parts": {
    order: [...canonicalMessageOrder, integer(0)],
    logicalKey: [messageIdentitySha256, integer(0)],
    dependencies: [dependency("messages", [conversationIdentitySha256, integer(0)])],
  },
  "large-files": {
    order: ["file-1"],
    logicalKey: ["file-1"],
    dependencies: [dependency("conversations", [conversationFingerprint, integer(0)])],
  },
  summaries: {
    order: [SUMMARY_ID],
    logicalKey: [SUMMARY_ID],
    dependencies: [dependency("conversations", [conversationFingerprint, integer(0)])],
  },
  "summary-file-links": {
    order: [SUMMARY_ID, integer(0)],
    logicalKey: [SUMMARY_ID, integer(0)],
    dependencies: [dependency("summaries", [SUMMARY_ID])],
  },
  "summary-message-links": {
    order: [SUMMARY_ID, messageIdentitySha256, integer(0)],
    logicalKey: [SUMMARY_ID, messageIdentitySha256],
    dependencies: sortDependencies([
      dependency("summaries", [SUMMARY_ID]),
      dependency("messages", [conversationIdentitySha256, integer(0)]),
    ]),
  },
  "summary-parent-links": {
    order: [SUMMARY_ID, "summary-parent", integer(0)],
    logicalKey: [SUMMARY_ID, "summary-parent"],
    dependencies: sortDependencies([
      dependency("summaries", [SUMMARY_ID]),
      dependency("summaries", ["summary-parent"]),
    ]),
  },
  "context-items": {
    order: [...canonicalConversationOrder, integer(0)],
    logicalKey: [conversationIdentitySha256, integer(0)],
    dependencies: sortDependencies([
      dependency("conversations", [conversationFingerprint, integer(0)]),
      dependency("messages", [conversationIdentitySha256, integer(0)]),
    ]),
  },
  "promoted-memories": {
    order: ["memory-1"],
    logicalKey: ["memory-1"],
    dependencies: [dependency("project", ["local", PROJECT_ID])],
  },
  "promoted-memory-tags": {
    order: ["memory-1", integer(0)],
    logicalKey: ["memory-1", integer(0)],
    dependencies: [dependency("promoted-memories", ["memory-1"])],
  },
  "recall-surfacings": {
    order: ["memory-1", null, TIMESTAMP, integer(0)],
    logicalKey: ["memory-1", null, TIMESTAMP, integer(0)],
    dependencies: [dependency("project", ["local", PROJECT_ID])],
  },
  "redaction-counters": {
    order: ["built_in"],
    logicalKey: ["built_in"],
    dependencies: [dependency("project", ["local", PROJECT_ID])],
  },
  "session-ingest": {
    order: [SESSION_ID],
    logicalKey: [SESSION_ID],
    dependencies: [dependency("project", ["local", PROJECT_ID])],
  },
  "session-instructions": {
    order: [MACHINE_IDENTITY, HASH],
    logicalKey: [MACHINE_IDENTITY, HASH],
    dependencies: sortDependencies([
      dependency("machines", [MACHINE_IDENTITY]),
      dependency("project", ["local", PROJECT_ID]),
    ]),
  },
  "native-transcripts": {
    order: [MACHINE_IDENTITY, HASH],
    logicalKey: [MACHINE_IDENTITY, HASH],
    dependencies: sortDependencies([
      dependency("machines", [MACHINE_IDENTITY]),
      dependency("project", ["local", PROJECT_ID]),
    ]),
  },
  "native-transcript-message-links": {
    order: [MACHINE_IDENTITY, HASH, integer(0)],
    logicalKey: [MACHINE_IDENTITY, HASH, integer(0)],
    dependencies: sortDependencies([
      dependency("native-transcripts", [MACHINE_IDENTITY, HASH]),
      dependency("messages", [conversationIdentitySha256, integer(0)]),
    ]),
  },
  "native-transcript-checkpoints": {
    order: [MACHINE_IDENTITY, "codex", "/home/user/transcript.jsonl"],
    logicalKey: [MACHINE_IDENTITY, "codex", "/home/user/transcript.jsonl"],
    dependencies: sortDependencies([
      dependency("machines", [MACHINE_IDENTITY]),
      dependency("project", ["local", PROJECT_ID]),
    ]),
  },
  "passive-events": {
    order: [MACHINE_IDENTITY, "00000000-0000-7000-8000-000000000001", integer(0)],
    logicalKey: [MACHINE_IDENTITY, "00000000-0000-7000-8000-000000000001"],
    dependencies: sortDependencies([
      dependency("machines", [MACHINE_IDENTITY]),
      dependency("project", ["local", PROJECT_ID]),
    ]),
  },
};

const bytes = (record: unknown): Uint8Array => serializePortableRecord(record as never);

const expectCode = (operation: () => unknown, code: string) => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(PortableStreamError);
    expect((error as PortableStreamError).code).toBe(code);
    return;
  }
  throw new Error("operation unexpectedly succeeded");
};

const captureError = (operation: () => unknown): PortableStreamError => {
  try {
    operation();
  } catch (error) {
    if (error instanceof PortableStreamError) return error;
    throw new Error("operation threw a non-PortableStreamError", { cause: error });
  }
  throw new Error("operation unexpectedly succeeded");
};

const expectDeepFrozen = (value: unknown, seen = new WeakSet<object>()): void => {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      expectDeepFrozen(descriptor.value, seen);
    }
  }
};

describe("portable record public seam", () => {
  it("exposes the frozen 22-domain order", () => {
    expect(PORTABLE_RECORD_DOMAIN_ORDER).toEqual([
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
    ]);
  });

  it("exposes the manifest-bound limits and an immutable descriptor", () => {
    expect(PORTABLE_LIMITS).toEqual({
      maxJsonDepth: 100,
      maxRecordBytes: 128 * 1024 * 1024,
      maxBatchRecords: 500,
      maxBatchBytes: 144 * 1024 * 1024,
      maxControlBytes: 1024 * 1024,
    });
    expect(Object.isFrozen(PORTABLE_LIMITS)).toBe(true);
    expect(Object.isFrozen(PORTABLE_RECORD_DOMAIN_ORDER)).toBe(true);
    expect(Object.isFrozen(PORTABLE_RECORD_SCHEMA_DESCRIPTOR)).toBe(true);
    expect(PORTABLE_RECORD_SCHEMA_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(PORTABLE_RECORD_SCHEMA_SHA256).toBe("5fd2432722dc42e80e2454f6e2db2a454da5fc6b2f69c7fa58594d9349f91e0f");
    expect(PORTABLE_RECORD_SCHEMA_DESCRIPTOR.canonicalization.integers.signedInt64).toEqual([
      "-9223372036854775808",
      "9223372036854775807",
    ]);
    expect(PORTABLE_RECORD_SCHEMA_DESCRIPTOR.envelope).toEqual([
      "version", "domain", "domainVersion", "ordinal", "order", "identitySha256",
      "dependencies", "value", "recordSha256",
    ]);
    expect(PORTABLE_RECORD_SCHEMA_DESCRIPTOR.domains).toHaveLength(22);
    expect(PORTABLE_RECORD_SCHEMA_DESCRIPTOR.domains.map((entry) => entry.domain)).toEqual(PORTABLE_RECORD_DOMAIN_ORDER);
    for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
      expect(PORTABLE_RECORD_SCHEMA_DESCRIPTOR.domainsByOrder[domain]).toMatchObject(expectedDomainSchema[domain]);
      expect(PORTABLE_RECORD_SCHEMA_DESCRIPTOR.domainsByOrder[domain].fields).toEqual(
        Object.keys(representativeValues[domain]),
      );
      expect(PORTABLE_RECORD_SCHEMA_DESCRIPTOR.domainsByOrder[domain].rules).toHaveLength(
        PORTABLE_RECORD_SCHEMA_DESCRIPTOR.domainsByOrder[domain].fields.length,
      );
      expect(Array.isArray(PORTABLE_RECORD_SCHEMA_DESCRIPTOR.domainsByOrder[domain].coverage)).toBe(true);
    }
    expect(validatePortableRecordSchemaDescriptor(PORTABLE_RECORD_SCHEMA_DESCRIPTOR)).toBe(true);
    const invalidOrder = structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR) as never;
    (invalidOrder as { domainsByOrder: { project: { order: string[] } } }).domainsByOrder.project.order.reverse();
    expect(validatePortableRecordSchemaDescriptor(invalidOrder)).toBe(false);
    const invalidContext = structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR) as never;
    (invalidContext as { domainsByOrder: { messages: { contextValidation: string[] } } })
      .domainsByOrder.messages.contextValidation = ["exact-object"];
    expect(validatePortableRecordSchemaDescriptor(invalidContext)).toBe(false);
    const invalidRules = structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR) as never;
    (invalidRules as { domainsByOrder: { messages: { rules: string[] } } })
      .domainsByOrder.messages.rules[0] = "string";
    expect(validatePortableRecordSchemaDescriptor(invalidRules)).toBe(false);
    const missingFields = structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR) as never;
    (missingFields as { domainsByOrder: { messages: { fields: unknown } } })
      .domainsByOrder.messages.fields = null;
    expect(validatePortableRecordSchemaDescriptor(missingFields)).toBe(false);
    const nonStringRule = structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR) as never;
    (nonStringRule as { domainsByOrder: { messages: { rules: unknown[] } } })
      .domainsByOrder.messages.rules[0] = 1;
    expect(validatePortableRecordSchemaDescriptor(nonStringRule)).toBe(false);
    const invalidCoverage = structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR) as never;
    (invalidCoverage as { domainsByOrder: { messages: { coverage: string[] } } })
      .domainsByOrder.messages.coverage = [];
    expect(validatePortableRecordSchemaDescriptor(invalidCoverage)).toBe(false);
    expect(validatePortableRecordSchemaDescriptor(null)).toBe(false);
    expect(validatePortableRecordSchemaDescriptor({
      ...structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR),
      version: 2,
    })).toBe(false);
    expect(validatePortableRecordSchemaDescriptor({
      ...structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR),
      domains: [],
    })).toBe(false);
    expect(validatePortableRecordSchemaDescriptor({
      ...structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR),
      domainsByOrder: null,
    })).toBe(false);
    const invalidInventory = structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR) as never;
    (invalidInventory as { domains: Array<{ domain: string }> }).domains[0].domain = "project";
    expect(validatePortableRecordSchemaDescriptor(invalidInventory)).toBe(false);
    const missingDomain = structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR) as never;
    (missingDomain as { domainsByOrder: Record<string, unknown> }).domainsByOrder.machines = null;
    expect(validatePortableRecordSchemaDescriptor(missingDomain)).toBe(false);
    const invalidDependencyOrder = structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR) as never;
    (invalidDependencyOrder as { domainsByOrder: { messages: { dependencies: string[] } } })
      .domainsByOrder.messages.dependencies = ["passive-events"];
    expect(validatePortableRecordSchemaDescriptor(invalidDependencyOrder)).toBe(false);
    const invalidCanonicalization = structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR) as never;
    (invalidCanonicalization as { canonicalization: { tupleStringOrder: string } })
      .canonicalization.tupleStringOrder = "unsigned-utf16-code-unit-order";
    expect(validatePortableRecordSchemaDescriptor(invalidCanonicalization)).toBe(false);
    const invalidClosure = structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR) as never;
    (invalidClosure as { domainsByOrder: { conversations: { conversationClosure: { algorithm: string[] } } } })
      .domainsByOrder.conversations.conversationClosure.algorithm.reverse();
    expect(validatePortableRecordSchemaDescriptor(invalidClosure)).toBe(false);
    const extraRoot = {
      ...structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR),
      extra: true,
    };
    expect(validatePortableRecordSchemaDescriptor(extraRoot)).toBe(false);
    const extraDomain = structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR) as never;
    (extraDomain as { domainsByOrder: { messages: Record<string, unknown> } })
      .domainsByOrder.messages.extra = true;
    expect(validatePortableRecordSchemaDescriptor(extraDomain)).toBe(false);
    const invalidDependencies = structuredClone(PORTABLE_RECORD_SCHEMA_DESCRIPTOR) as never;
    (invalidDependencies as { domainsByOrder: { messages: { dependencies: unknown } } })
      .domainsByOrder.messages.dependencies = null;
    expect(validatePortableRecordSchemaDescriptor(invalidDependencies)).toBe(false);
    const trappedDescriptor = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("descriptor trap");
      },
    });
    expect(validatePortableRecordSchemaDescriptor(trappedDescriptor)).toBe(false);
    const trappedDescriptorRead = new Proxy({}, {
      getPrototypeOf() {
        return Object.prototype;
      },
      get() {
        throw new Error("descriptor read trap");
      },
    });
    expect(validatePortableRecordSchemaDescriptor(trappedDescriptorRead)).toBe(false);
    expectDeepFrozen(PORTABLE_LIMITS);
    expectDeepFrozen(PORTABLE_RECORD_DOMAIN_ORDER);
    expectDeepFrozen(PORTABLE_RECORD_SCHEMA_DESCRIPTOR);
  });

  it("freezes the transient construction contract and independent identity witnesses", () => {
    expect(PORTABLE_RECORD_SCHEMA_DESCRIPTOR.canonicalization).toMatchObject({
      objectKeyOrder: "unsigned-utf16-code-unit-order",
      tupleStringOrder: "unsigned-utf8-byte-order",
    });
    expect(PORTABLE_RECORD_SCHEMA_DESCRIPTOR.domainsByOrder.project.logicalKey).toEqual([
      "identity.scope",
      "identity.projectId",
    ]);
    for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
      expect(PORTABLE_RECORD_SCHEMA_DESCRIPTOR.domainsByOrder[domain]).toMatchObject(
        expectedConstructionContract[domain],
      );
    }
    expect(PORTABLE_RECORD_SCHEMA_DESCRIPTOR.domainsByOrder.conversations.conversationClosure).toEqual(
      expectedConversationClosureDescriptor,
    );
    expect(conversationFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(conversationIdentitySha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(messageIdentitySha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(projectIdentitySha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(representativeValues.conversations.conversationFingerprint).toBe(conversationFingerprint);
    expect(representativeValues.messages.conversationIdentitySha256).toBe(conversationIdentitySha256);
    expect(representativeValues["message-parts"].messageIdentitySha256).toBe(messageIdentitySha256);
  });

  it.each(PORTABLE_RECORD_DOMAIN_ORDER)("creates a frozen canonical %s record", (domain) => {
    const record = create(domain, representativeValues[domain]);
    const expected = expectedRecordShapes[domain];
    expect(record).toMatchObject({ version: 1, domain, domainVersion: 1, ordinal: 0 });
    expect(record.order).toEqual(expected.order);
    expect(record.identitySha256).toBe(identitySha256(domain, expected.logicalKey));
    expect(record.dependencies).toEqual(expected.dependencies);
    const { recordSha256, ...withoutRecordSha256 } = record;
    expect(recordSha256).toBe(independentlyHashed(withoutRecordSha256));
    expect(recordSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.order)).toBe(true);
    expect(Object.isFrozen(record.dependencies)).toBe(true);
    expect(Object.isFrozen(record.value)).toBe(true);
    expectDeepFrozen(record);
    expect(Reflect.set(record as object, "domain", "project")).toBe(false);
    expect(record.domain).toBe(domain);
    expect(Reflect.set(record.value as object, "tampered", true)).toBe(false);
    expect(record.value).not.toHaveProperty("tampered");
  });

  it("validates construction context shape, parent binding, and discards context from the wire", () => {
    const record = create("messages", representativeValues.messages);
    const encoded = Buffer.from(bytes(record)).toString("utf8");
    expect(encoded).not.toContain("conversationOrder");
    expect(encoded).not.toContain("projectIdentity");
    expect(record).not.toHaveProperty("context");
    expectCode(() => createPortableRecord({
      domain: "messages",
      ordinal: 0,
      value: representativeValues.messages,
    } as never), "malformed-record");
    expectCode(() => create("messages", representativeValues.messages, 0, {
      conversationOrder,
      extra: true,
    }), "malformed-record");
    expectCode(() => create("messages", representativeValues.messages, 0, { projectIdentity }), "malformed-record");
    expectCode(() => create("messages", representativeValues.messages, 0, { conversationOrder: ["wrong"] }), "malformed-record");
    expectCode(() => create("messages", representativeValues.messages, 0, {
      conversationOrder: [...conversationOrder.slice(0, -1), 1],
    }), "malformed-record");
    expectCode(() => create("message-parts", representativeValues["message-parts"], 0, {
      messageOrder: [...messageOrder.slice(0, -1), 1],
    }), "malformed-record");
    expectCode(() => create("project-aliases", representativeValues["project-aliases"], 0, {
      projectIdentity: { scope: "shared", projectId: PROJECT_ID },
    }), "malformed-record");
    expectCode(() => create("machines", representativeValues.machines, 0, {}), "malformed-record");
    expectCode(() => createPortableRecord({
      domain: "large-files",
      ordinal: 0,
      value: representativeValues["large-files"],
      context: undefined,
    } as never), "malformed-record");
  });

  it("validates local/shared project identities and scalar project logical keys", () => {
    expect(create("project", representativeValues.project).identitySha256).toBe(projectIdentitySha256);
    const sharedIdentity = {
      scope: "shared" as const,
      projectId: "018f7765-7b5c-7d92-8a2e-c6f6a15fca34",
    };
    const shared = create("project", { identity: sharedIdentity });
    expect(shared.order).toEqual(["shared", sharedIdentity.projectId]);
    expect(shared.identitySha256).toBe(identitySha256("project", ["shared", sharedIdentity.projectId]));
    expect(shared.identitySha256).not.toBe(identitySha256("project", [sharedIdentity]));
    expectCode(() => create("project", { identity: { scope: "local", projectId: PROJECT_ID.toUpperCase() } }), "malformed-record");
    expectCode(() => create("project", { identity: { scope: "local", projectId: "not-a-sha256" } }), "malformed-record");
    expectCode(() => create("project", { identity: { scope: "shared", projectId: PROJECT_ID } }), "malformed-record");
    expectCode(() => create("project", {
      identity: { scope: "shared", projectId: "018f7765-7b5c-6d92-8a2e-c6f6a15fca34" },
    }), "malformed-record");
    expectCode(() => create("project", {
      identity: { scope: "shared", projectId: sharedIdentity.projectId.toUpperCase() },
    }), "malformed-record");
  });

  it("authenticates native canonical byte witnesses before applying byte ceilings", () => {
    const value = representativeValues["native-transcripts"];
    const context = nativeContext(value);
    expect(create("native-transcripts", value, 0, context)).toBeTruthy();
    expectCode(() => create("native-transcripts", value, 0, {
      ...context,
      canonicalPayloadBytes: context.canonicalPayloadBytes + 1,
    }), "malformed-record");
    expectCode(() => create("native-transcripts", value, 0, {
      ...context,
      canonicalMetadataBytes: context.canonicalMetadataBytes + 1,
    }), "malformed-record");
    expectCode(() => create("native-transcripts", value, 0, {
      ...context,
      canonicalPayloadBytes: 100 * 1024 * 1024 + 1,
    }), "malformed-record");
    expectCode(() => create("native-transcripts", value, 0, {
      ...context,
      canonicalMetadataBytes: PORTABLE_LIMITS.maxControlBytes + 1,
    }), "malformed-record");
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectCode(() => create("native-transcripts", value, 0, {
        ...context,
        canonicalPayloadBytes: invalid,
      }), "malformed-record");
    }
  });

  it("creates exact machine and project envelopes with domain-separated identity hashes", () => {
    const machine = create("machines", representativeValues.machines);
    const project = create("project", representativeValues.project);
    expect(machine.order).toEqual([MACHINE_IDENTITY]);
    expect(project.order).toEqual(["local", PROJECT_ID]);
    expect(machine.dependencies).toEqual([]);
    expect(project.dependencies).toEqual([]);
    expect(machine.identitySha256).not.toBe(project.identitySha256);
    expect(machine.recordSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(machine.value).toEqual(representativeValues.machines);
    expect(project.value).toEqual(representativeValues.project);
  });

  it("serializes and parses every representative record byte-for-byte", () => {
    for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
      const record = create(domain, representativeValues[domain]);
      const encoded = bytes(record);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(encoded).toString("utf8")).toMatch(/^\{.*\}\n$/u);
      const parsed = parsePortableRecord(encoded);
      expect(parsed).toEqual(record);
      expect(bytes(parsed)).toEqual(encoded);
    }
  });

  it("uses canonical sorted object keys, UTF-8 escapes, and array order", () => {
    const record = create("promoted-memories", {
      ...representativeValues["promoted-memories"],
      content: "ASCII café 🚀 \\ \" \n",
      metadata: { z: [2, 1, 0], a: "é" },
    });
    const text = Buffer.from(bytes(record)).toString("utf8");
    expect(text).toContain("\\n");
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"z"'));
    expect(text).toContain("é");
    expect(parsePortableRecord(bytes(record))).toEqual(record);
  });

  it("matches the independent canonical schema digest formula and byte encoding", () => {
    const preimage = ["lcm-portable-schema-v1", PORTABLE_RECORD_SCHEMA_DESCRIPTOR];
    const canonical = canonicalJson(preimage);
    const independentlyHashed = createHash("sha256")
      .update(Buffer.from(canonical, "utf8"))
      .digest("hex");
    expect(canonicalJsonBytes(preimage)).toEqual(Buffer.from(canonical, "utf8"));
    expect(independentlyHashed).toBe(PORTABLE_RECORD_SCHEMA_SHA256);
    expect(canonicalSha256(preimage)).toBe(PORTABLE_RECORD_SCHEMA_SHA256);
    expect(PORTABLE_RECORD_SCHEMA_SHA256).toBe("5fd2432722dc42e80e2454f6e2db2a454da5fc6b2f69c7fa58594d9349f91e0f");
  });

  it("freezes independent canonical bytes and digest vectors", () => {
    const vector = {
      z: [integer("-9223372036854775808"), "é", "\n"],
      a: { number: 1.5e-7, escaped: "\\\"" },
    };
    const expected = referenceCanonicalJson(vector);
    expect(canonicalJson(vector)).toBe(expected);
    expect(canonicalJsonBytes(vector)).toEqual(Buffer.from(expected, "utf8"));
    expect(sha256(Buffer.from(expected, "utf8"))).toBe(independentlyHashed(vector));
    expect(canonicalJson([integer(0), integer(-1), integer(10)])).toBe(
      '[{"$integer":"0"},{"$integer":"-1"},{"$integer":"10"}]',
    );
    const record = create("project", representativeValues.project);
    expect(record.identitySha256).toBe("48fe03f1e75fe5493511541608343b4bc9f450ea0d7c6e320a1e075c32d89663");
    expect(record.recordSha256).toBe(independentlyHashed({
      version: 1,
      domain: "project",
      domainVersion: 1,
      ordinal: 0,
      order: ["local", PROJECT_ID],
      identitySha256: record.identitySha256,
      dependencies: [],
      value: { identity: projectIdentity },
    }));
  });

  it("rejects tampered hashes, unknown domains, unsupported versions, and noncanonical bytes", () => {
    const record = create("machines", representativeValues.machines);
    const encoded = Buffer.from(bytes(record));
    const tampered = JSON.parse(encoded.toString("utf8")) as Record<string, unknown>;
    tampered.recordSha256 = "e".repeat(64);
    expectCode(() => parsePortableRecord(Buffer.from(`${JSON.stringify(tampered)}\n`)), "malformed-record");
    expectCode(() => parsePortableRecord(Buffer.from(encoded.toString("utf8").replace('"machines"', '"unknown"'))), "unknown-domain");
    expectCode(() => parsePortableRecord(Buffer.from(encoded.toString("utf8").replace('"version":1', '"version":2'))), "unsupported-version");
    expectCode(() => parsePortableRecord(Buffer.from(` ${encoded.toString("utf8")}`)), "malformed-record");
    expectCode(() => parsePortableRecord(Buffer.from(encoded.toString("utf8").replace('"version":1', '"version":1.0'))), "malformed-record");
  });

  it("rejects exact-key violations, invalid ordinals, and unsafe or malformed scalar values", () => {
    expectCode(() => create("machines", { ...representativeValues.machines, extra: true }), "malformed-record");
    expectCode(() => create("machines", { identityKey: "\u0000", machineId: null }), "malformed-record");
    expectCode(() => create("machines", { identityKey: "\ud800", machineId: null }), "malformed-record");
    const rocket = create("machines", { identityKey: "\ud83d\ude80", machineId: null });
    expect(rocket.value.identityKey).toBe("\ud83d\ude80");
    expectCode(() => create("messages", { ...representativeValues.messages, tokenCount: "9223372036854775808" }), "record-unrepresentable");
    expectCode(() => create("messages", { ...representativeValues.messages, tokenCount: "-1" }), "record-unrepresentable");
    expectCode(() => create("messages", { ...representativeValues.messages, seq: "01" }), "malformed-record");
    expectCode(() => create("promoted-memories", { ...representativeValues["promoted-memories"], confidence: Number.NaN }), "malformed-record");
    expectCode(() => create("promoted-memories", { ...representativeValues["promoted-memories"], confidence: -0 }), "malformed-record");
    expectCode(() => create("promoted-memories", { ...representativeValues["promoted-memories"], metadata: undefined }), "malformed-record");
  });

  it("accepts integer extrema and rejects each six-range boundary outside its range", () => {
    const extrema = [
      "-9223372036854775808",
      "9223372036854775807",
      "0",
      "2147483647",
      "1",
      "9007199254740991",
    ];
    expect(create("messages", { ...representativeValues.messages, seq: extrema[2], tokenCount: extrema[1] })).toBeTruthy();
    expect(create("redaction-counters", { category: "global", count: extrema[1] })).toBeTruthy();
    expect(create("summaries", { ...representativeValues.summaries, depth: extrema[3] })).toBeTruthy();
    expect(create("summary-file-links", { ...representativeValues["summary-file-links"], ordinal: extrema[3] })).toBeTruthy();
    expect(create("conversations", { ...representativeValues.conversations, occurrenceOrdinal: 9007199254740991 })).toBeTruthy();
    expect(create("passive-events", { ...representativeValues["passive-events"], priority: -9007199254740991 })).toBeTruthy();
    for (const value of ["9223372036854775808", "-9223372036854775809", "-1"]) {
      expectCode(() => create("messages", { ...representativeValues.messages, tokenCount: value }), "record-unrepresentable");
    }
    for (const value of ["01", "+1", "-0"]) {
      expectCode(() => create("messages", { ...representativeValues.messages, tokenCount: value }), "malformed-record");
    }
    expectCode(() => create("conversations", { ...representativeValues.conversations, occurrenceOrdinal: Number.MAX_SAFE_INTEGER + 1 }), "malformed-record");
    expectCode(() => create("passive-events", { ...representativeValues["passive-events"], priority: Number.NaN }), "malformed-record");
  });

  it("rejects invalid timestamps, cycles, shared cycles, exotic prototypes, accessors, symbols, and sparse arrays", () => {
    for (const timestamp of [
      "2026-02-29T12:00:00.000000Z",
      "2026-08-13T25:00:00.000000Z",
      "2026-08-13T12:34:56.1234567Z",
      "2026-08-13 12:34:56+00:00",
    ]) {
      expectCode(() => create("conversations", { ...representativeValues.conversations, createdAt: timestamp }), "malformed-record");
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectCode(() => create("promoted-memories", { ...representativeValues["promoted-memories"], metadata: cyclic }), "malformed-record");
    const shared = { x: 1 };
    expectCode(() => create("promoted-memories", { ...representativeValues["promoted-memories"], metadata: { a: shared, b: shared } }), "malformed-record");
    expectCode(() => create("promoted-memories", { ...representativeValues["promoted-memories"], metadata: Object.create({ x: 1 }) }), "malformed-record");
    const accessor = { get x() { return 1; } };
    expectCode(() => create("promoted-memories", { ...representativeValues["promoted-memories"], metadata: accessor }), "malformed-record");
    let valueAccessorCalls = 0;
    const valueAccessor = { ...representativeValues.messages };
    Object.defineProperty(valueAccessor, "content", {
      enumerable: true,
      get() {
        valueAccessorCalls += 1;
        return "accessor content";
      },
    });
    expectCode(() => create("messages", valueAccessor), "malformed-record");
    expect(valueAccessorCalls).toBe(0);
    let contextAccessorCalls = 0;
    const contextAccessor = Object.defineProperty({}, "projectIdentity", {
      enumerable: true,
      get() {
        contextAccessorCalls += 1;
        return projectIdentity;
      },
    });
    expectCode(() => create("session-ingest", representativeValues["session-ingest"], 0, contextAccessor), "malformed-record");
    expect(contextAccessorCalls).toBe(0);
    const symbol = Symbol("secret");
    expectCode(() => create("promoted-memories", { ...representativeValues["promoted-memories"], metadata: { [symbol]: 1 } }), "malformed-record");
    const sparse: unknown[] = [];
    sparse.length = 1;
    expectCode(() => create("native-transcripts", { ...representativeValues["native-transcripts"], nativePayload: sparse }), "malformed-record");
    let arrayAccessorCalls = 0;
    const arrayAccessor = ["safe"];
    Object.defineProperty(arrayAccessor, "0", {
      enumerable: true,
      configurable: true,
      get() {
        arrayAccessorCalls += 1;
        return "accessor content";
      },
    });
    expectCode(() => create("native-transcripts", {
      ...representativeValues["native-transcripts"],
      nativePayload: arrayAccessor,
    }, 0, {
      projectIdentity,
      canonicalPayloadBytes: 0,
      canonicalMetadataBytes: 0,
    }), "malformed-record");
    expect(arrayAccessorCalls).toBe(0);
    const exoticArray = ["safe"];
    Object.setPrototypeOf(exoticArray, Object.create(Array.prototype));
    expectCode(() => create("native-transcripts", {
      ...representativeValues["native-transcripts"],
      nativePayload: exoticArray,
    }), "malformed-record");

    let orderAccessorCalls = 0;
    const orderAccessor = [...conversationOrder];
    Object.defineProperty(orderAccessor, "0", {
      enumerable: true,
      configurable: true,
      get() {
        orderAccessorCalls += 1;
        return SESSION_ID;
      },
    });
    expectCode(() => create("messages", representativeValues.messages, 0, {
      conversationOrder: orderAccessor,
    }), "malformed-record");
    expect(orderAccessorCalls).toBe(0);

    let dependencyAccessorCalls = 0;
    const machine = create("machines", representativeValues.machines);
    const dependencyAccessor: unknown[] = [];
    Object.defineProperty(dependencyAccessor, "0", {
      enumerable: true,
      configurable: true,
      get() {
        dependencyAccessorCalls += 1;
        return { domain: "project", identitySha256: HASH };
      },
    });
    dependencyAccessor.length = 1;
    expectCode(() => serializePortableRecord({
      ...machine,
      dependencies: dependencyAccessor,
    } as never), "malformed-record");
    expect(dependencyAccessorCalls).toBe(0);
  });

  it("enforces JSON depth, exact nullability, context target exclusivity, DAG sanity, and dependencies", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 100; depth += 1) nested = { nested };
    expect(create("native-transcripts", { ...representativeValues["native-transcripts"], nativePayload: nested })).toBeTruthy();
    nested = "leaf";
    for (let depth = 0; depth < 101; depth += 1) nested = { nested };
    expectCode(() => create("native-transcripts", { ...representativeValues["native-transcripts"], nativePayload: nested }), "malformed-record");
    expectCode(() => create("context-items", { ...representativeValues["context-items"], messageIdentitySha256: MESSAGE_ID, summaryId: SUMMARY_ID }), "malformed-record");
    expectCode(() => create("context-items", { ...representativeValues["context-items"], messageIdentitySha256: null, summaryId: null }), "malformed-record");
    expectCode(() => create("summary-parent-links", { ...representativeValues["summary-parent-links"], parentSummaryId: SUMMARY_ID }), "malformed-record");
    const record = create("project-aliases", representativeValues["project-aliases"]);
    expect(record.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "machines" }),
      expect.objectContaining({ domain: "project" }),
    ]));
    expect(record.dependencies).toEqual([...record.dependencies].sort((a, b) => a.domain.localeCompare(b.domain)));
  });

  it("compares portable order tuples by null, UTF-8 string, and numeric precedence", () => {
    expect(comparePortableOrder([null], ["a"])).toBeLessThan(0);
    expect(comparePortableOrder(["a"], [null])).toBeGreaterThan(0);
    expect(comparePortableOrder(["a"], ["a"])).toBe(0);
    expect(comparePortableOrder(["a"], ["b"])).toBeLessThan(0);
    expect(comparePortableOrder(["é"], ["z"])).toBeGreaterThan(0);
    expect(comparePortableOrder([integer("-2")], [integer("1")])).toBeLessThan(0);
    expect(comparePortableOrder([integer("2")], [integer("10")])).toBeLessThan(0);
    expect(comparePortableOrder([integer("-9223372036854775808")], [integer("0")])).toBeLessThan(0);
    expect(comparePortableOrder([integer("0")], [integer("-9223372036854775808")])).toBeGreaterThan(0);
    expectCode(() => comparePortableOrder([integer("-9223372036854775809")], [integer("0")]), "record-unrepresentable");
    expect(comparePortableOrder(["a", integer("1")], ["a", integer("2")])).toBeLessThan(0);
    expectCode(() => comparePortableOrder([], [null]), "malformed-record");
    expectCode(() => comparePortableOrder([{ $integer: "01" } as never], [{ $integer: "1" } as never]), "malformed-record");
    expectCode(() => comparePortableOrder(["contains\u0000nul"], ["safe"]), "malformed-record");
    expectCode(() => comparePortableOrder([true as never], [false as never]), "malformed-record");
    expect(comparePortableOrder(["\uE000"], ["\u{10000}"])).toBeLessThan(0);
    expect(canonicalJson({ "\uE000": 1, "\u{10000}": 2 })).toBe('{"𐀀":2,"":1}');
  });

  it("normalizes adapter integer and timestamp inputs without losing precision", () => {
    const record = create("messages", {
      ...representativeValues.messages,
      seq: "7",
      tokenCount: 8n,
      createdAt: "2026-08-13 12:34:56.123",
    });
    expect(record.value.seq).toEqual(integer(7));
    expect(record.value.tokenCount).toEqual(integer(8));
    expect(record.value.createdAt).toBe("2026-08-13T12:34:56.123000Z");
    const datedCreatedAt = "2026-08-13T12:34:56.000000Z";
    const dated = create("conversations", {
      ...representativeValues.conversations,
      conversationFingerprint: independentlyHashed([
        "lcm-portable-conversation-value-v1",
        SESSION_ID,
        CONVERSATION_TITLE,
        CONVERSATION_BOOTSTRAPPED_AT,
        datedCreatedAt,
        CONVERSATION_UPDATED_AT,
      ]),
      createdAt: new Date("2026-08-13T12:34:56.000Z"),
    });
    expect(dated.value.createdAt).toBe(datedCreatedAt);
    expectCode(() => create("messages", { ...representativeValues.messages, tokenCount: "1.5" }), "malformed-record");
    expectCode(() => create("messages", { ...representativeValues.messages, tokenCount: -0 }), "malformed-record");
    expectCode(() => create("messages", { ...representativeValues.messages, tokenCount: integer(1) }), "malformed-record");
    expect(create("session-ingest", {
      ...representativeValues["session-ingest"],
      completedAt: "0001-01-01T00:00:00.000000Z",
    }).value.completedAt).toBe("0001-01-01T00:00:00.000000Z");
    const exoticDate = new Date("2026-08-13T12:34:56.000Z");
    Object.setPrototypeOf(exoticDate, Object.create(Date.prototype));
    expectCode(() => create("session-ingest", {
      ...representativeValues["session-ingest"],
      completedAt: exoticDate,
    }), "malformed-record");
  });

  it("preserves caller-owned UUID spelling and requires canonical registered UUIDv7 bindings", () => {
    const uppercaseEventId = "00000000-0000-7000-8000-000000000ABC";
    expect(create("passive-events", {
      ...representativeValues["passive-events"],
      eventId: uppercaseEventId,
    }).value.eventId).toBe(uppercaseEventId);
    expectCode(() => create("machines", {
      identityKey: MACHINE_IDENTITY,
      machineId: uppercaseEventId,
    }), "malformed-record");
  });

  it("rejects identity, order, dependency, and record digest tampering", () => {
    const record = create("machines", representativeValues.machines);
    const encoded = JSON.parse(Buffer.from(bytes(record)).toString("utf8")) as Record<string, unknown>;
    for (const [field, value] of [
      ["identitySha256", HASH],
      ["recordSha256", HASH],
      ["order", ["different"]],
      ["dependencies", [{ domain: "project", identitySha256: HASH }]],
    ] as const) {
      expectCode(() => parsePortableRecord(Buffer.from(`${JSON.stringify({ ...encoded, [field]: value })}\n`)), "malformed-record");
    }
    expectCode(() => parsePortableRecord(Buffer.from(`${JSON.stringify({ ...encoded, domainVersion: 2 })}\n`)), "unsupported-version");
    expectCode(() => parsePortableRecord(Buffer.from(`${JSON.stringify({ ...encoded, extra: "field" })}\n`)), "malformed-record");

    const ingest = create("session-ingest", representativeValues["session-ingest"]);
    const noncanonicalInteger = Buffer.from(bytes(ingest)).toString("utf8").replace(
      '"messageCount":{"$integer":"1"}',
      '"messageCount":1',
    );
    expectCode(() => parsePortableRecord(Buffer.from(noncanonicalInteger, "utf8")), "malformed-record");
  });

  it("rejects forbidden JSON values and oversized UTF-8 before parser work", () => {
    for (const forbidden of [undefined, Symbol("x"), () => 1, 1n, Infinity, -Infinity, NaN, -0]) {
      expectCode(() => create("promoted-memories", {
        ...representativeValues["promoted-memories"],
        metadata: { forbidden },
      }), "malformed-record");
    }
    const tooLarge = new Uint8Array(PORTABLE_LIMITS.maxRecordBytes + 1);
    expectCode(() => parsePortableRecord(tooLarge), "record-unrepresentable");
    expectCode(() => create("messages", {
      ...representativeValues.messages,
      content: "x".repeat(PORTABLE_LIMITS.maxRecordBytes),
    }), "record-unrepresentable");
    expectCode(() => parsePortableRecord(Buffer.from("null\n")), "malformed-record");
    expectCode(() => parsePortableRecord(Buffer.from("{\"domain\":\"machines\"}\n")), "malformed-record");
  }, 120_000);

  it("enforces the complete newline-framed 128 MiB record boundary", () => {
    const empty = create("messages", {
      ...representativeValues.messages,
      content: "",
    });
    expect(serializePortableRecord(empty).byteLength).toBe(722);

    const exactContentBytes = PORTABLE_LIMITS.maxRecordBytes - 722;
    const exact = create("messages", {
      ...representativeValues.messages,
      content: "x".repeat(exactContentBytes),
    });
    expect(exact.value.content).toHaveLength(exactContentBytes);
    expectCode(() => create("messages", {
      ...representativeValues.messages,
      content: "x".repeat(exactContentBytes + 1),
    }), "record-unrepresentable");
  }, 120_000);

  it("rejects every fixed error code only through safe bounded fields", () => {
    const codes = [
      "unsupported-version",
      "unknown-domain",
      "malformed-record",
      "record-unrepresentable",
      "duplicate-identity",
      "order-regression",
      "dependency-order",
    ] as const;
    for (const code of codes) {
      const error = new PortableStreamError(code, {
        domain: "passive-events",
        ordinal: 3,
        recordCount: 4,
        manifestSha256: HASH,
        checkpointSha256: HASH,
        retryable: code === "record-unrepresentable",
      });
      expect(error.toJSON()).toEqual({
        name: "PortableStreamError",
        code,
        retryable: code === "record-unrepresentable",
        domain: "passive-events",
        ordinal: 3,
        recordCount: 4,
        manifestSha256: HASH,
        checkpointSha256: HASH,
        message: `Portable record stream error: ${code}`,
      });
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("preserves canonical JSON arrays and rejects array mutation surface", () => {
    const value = { b: [3, 2, 1], a: ["x", "x", null] };
    expect(canonicalJson(value)).toBe('{"a":["x","x",null],"b":[3,2,1]}');
    const record = create("native-transcripts", {
      ...representativeValues["native-transcripts"],
      nativePayload: ["first", { z: 1, a: 2 }],
    });
    expectDeepFrozen(record.value.nativePayload);
    expect(Reflect.set(record.value.nativePayload as object, "0", "changed")).toBe(false);
    expect(record.value.nativePayload).toEqual(["first", { z: 1, a: 2 }]);
  });

  it("rejects parser whitespace, trailing bytes, duplicate keys, invalid UTF-8, and invalid newline framing", () => {
    const encoded = Buffer.from(bytes(create("machines", representativeValues.machines)));
    expectCode(() => parsePortableRecord(Buffer.concat([encoded, Buffer.from("\n")])), "malformed-record");
    expectCode(() => parsePortableRecord(Buffer.from(encoded.toString().replace(/\n$/u, " \n"))), "malformed-record");
    const duplicateVersion = Buffer.from(encoded.toString().replace(/^\{/u, '{"version":1,'));
    expectCode(() => parsePortableRecord(duplicateVersion), "malformed-record");
    expectCode(() => parsePortableRecord(Uint8Array.from([0xff, 0xfe, 0xfd])), "malformed-record");
    expectCode(() => parsePortableRecord(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      encoded,
    ])), "malformed-record");
    expectCode(() => parsePortableRecord(Buffer.from(encoded.toString().replace(/\n$/u, ""))), "malformed-record");
  });

  it("rejects invalid domain ordinals and malformed dependencies without echoing input", () => {
    const record = create("machines", representativeValues.machines);
    const parsed = JSON.parse(Buffer.from(bytes(record)).toString("utf8")) as Record<string, unknown>;
    for (const ordinal of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "0"]) {
      expectCode(() => parsePortableRecord(Buffer.from(`${JSON.stringify({ ...parsed, ordinal })}\n`)), "malformed-record");
    }
    for (const dependencies of [
      [{ domain: "machines", identitySha256: HASH }],
      [{ domain: "unknown", identitySha256: HASH }],
      [{ domain: "project" }],
      [{ domain: "project", identitySha256: "not-a-hash" }],
    ]) {
      const error = captureError(() => parsePortableRecord(Buffer.from(`${JSON.stringify({ ...parsed, dependencies })}\n`)));
      expect(error.code).toBe("malformed-record");
      expect(error.message).not.toContain("unknown");
      expect(error.message).not.toContain(HASH);
    }
  });

  it("reports fixed, cause-free, secret-free error JSON and stack text", () => {
    const secret = "/secret/path?quarantine=CANARY";
    const error = new PortableStreamError("malformed-record", {
      domain: "machines",
      ordinal: 7,
      recordCount: 8,
      manifestSha256: HASH,
      checkpointSha256: HASH,
      retryable: true,
    });
    const json = error.toJSON();
    expect(json).toEqual({
      name: "PortableStreamError",
      code: "malformed-record",
      retryable: true,
      domain: "machines",
      ordinal: 7,
      recordCount: 8,
      manifestSha256: HASH,
      checkpointSha256: HASH,
      message: "Portable record stream error: malformed-record",
    });
    expect(JSON.stringify(json)).toBe(`{"name":"PortableStreamError","code":"malformed-record","retryable":true,"domain":"machines","ordinal":7,"recordCount":8,"manifestSha256":"${HASH}","checkpointSha256":"${HASH}","message":"Portable record stream error: malformed-record"}`);
    expect(JSON.stringify(json)).not.toContain(secret);
    expect(error.cause).toBeUndefined();
    expect(error.stack?.split("\n", 1)[0]).toBe("PortableStreamError: Portable record stream error: malformed-record");
    expect(error.stack).not.toContain(secret);
    const noOptions = new PortableStreamError("malformed-record").toJSON();
    expect(noOptions).toEqual({
      name: "PortableStreamError",
      code: "malformed-record",
      retryable: false,
      message: "Portable record stream error: malformed-record",
    });
    expect(JSON.stringify(noOptions)).toBe("{\"name\":\"PortableStreamError\",\"code\":\"malformed-record\",\"retryable\":false,\"message\":\"Portable record stream error: malformed-record\"}");
    const unsafe = new PortableStreamError("malformed-record", {
      domain: "secret-domain" as never,
      ordinal: -1,
      recordCount: Number.NaN,
      manifestSha256: "/secret/manifest",
      checkpointSha256: "password=canary",
      retryable: "secret-retry" as never,
    });
    expect(unsafe.toJSON()).toEqual({
      name: "PortableStreamError",
      code: "malformed-record",
      retryable: false,
      message: "Portable record stream error: malformed-record",
    });
    expect(JSON.stringify(unsafe)).not.toContain("secret");
    expect(JSON.stringify(unsafe)).not.toContain("password");

    expect(new PortableStreamError("malformed-record", null as never).toJSON()).toEqual({
      name: "PortableStreamError",
      code: "malformed-record",
      retryable: false,
      message: "Portable record stream error: malformed-record",
    });
    let optionAccessorCalls = 0;
    const accessorOptions = Object.defineProperty({}, "manifestSha256", {
      enumerable: true,
      get() {
        optionAccessorCalls += 1;
        return "/secret/manifest";
      },
    });
    expect(new PortableStreamError("malformed-record", accessorOptions).toJSON()).toEqual({
      name: "PortableStreamError",
      code: "malformed-record",
      retryable: false,
      message: "Portable record stream error: malformed-record",
    });
    expect(optionAccessorCalls).toBe(0);
    const trappedOptions = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("secret option trap");
      },
    });
    expect(new PortableStreamError("malformed-record", trappedOptions).toJSON()).toEqual({
      name: "PortableStreamError",
      code: "malformed-record",
      retryable: false,
      message: "Portable record stream error: malformed-record",
    });
    const unsafeCode = new PortableStreamError("/secret/error-code" as never);
    expect(unsafeCode.code).toBe("malformed-record");
    expect(unsafeCode.message).toBe("Portable record stream error: malformed-record");
    expect(unsafeCode.stack).not.toContain("/secret/error-code");
  });

  it("covers canonical scalar, container, and comparator rejection branches", () => {
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expectCode(() => canonicalJson("\udc00"), "malformed-record");
    expectCode(() => canonicalJson(Object.create(null, {
      value: { get: () => 1, enumerable: true },
    })), "malformed-record");
    const arrayWithProperty = [1] as unknown[] & { extra?: number };
    arrayWithProperty.extra = 2;
    expectCode(() => canonicalJson(arrayWithProperty), "malformed-record");
    const arrayWithSymbol = [1] as unknown[] & { [key: symbol]: number };
    arrayWithSymbol[Symbol("extra")] = 2;
    expectCode(() => canonicalJson(arrayWithSymbol), "malformed-record");
    const arrayWithLeadingZero = [1] as unknown[] & Record<string, unknown>;
    arrayWithLeadingZero["01"] = 2;
    expectCode(() => canonicalJson(arrayWithLeadingZero), "malformed-record");
    expectCode(() => canonicalJson(new Map()), "malformed-record");
    const trappedObject = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("secret object prototype trap");
      },
    });
    expectCode(() => canonicalJson(trappedObject), "malformed-record");
    const trappedDescriptorObject = new Proxy({ value: 1 }, {
      getOwnPropertyDescriptor() {
        throw new Error("secret property descriptor trap");
      },
    });
    expectCode(() => canonicalJson(trappedDescriptorObject), "malformed-record");
    const trappedArray = new Proxy([1], {
      ownKeys() {
        throw new Error("secret array key trap");
      },
    });
    expectCode(() => canonicalJson(trappedArray), "malformed-record");
    const trappedArrayPrototype = new Proxy([1], {
      getPrototypeOf() {
        throw new Error("secret array prototype trap");
      },
    });
    expectCode(() => canonicalJson(trappedArrayPrototype), "malformed-record");
    expect(canonicalJson(Object.create(null, { a: { value: 1, enumerable: true } }))).toBe('{"a":1}');
    expect(comparePortableOrder([null], [null])).toBe(0);
    expect(comparePortableOrder(["a"], [integer(1)])).toBeLessThan(0);
    expect(comparePortableOrder([integer(1)], ["a"])).toBeGreaterThan(0);
    expect(comparePortableOrder([integer(1)], [integer(1)])).toBe(0);
    expectCode(() => comparePortableOrder([{ $integer: 1 } as never], [integer(1)]), "malformed-record");
    expect(comparePortableOrder(["aa"], ["a"])).toBeGreaterThan(0);
    expect(comparePortableOrder(["a"], ["aa"])).toBeLessThan(0);
    expect(canonicalJson({ aa: 1, a: 2 })).toBe('{"a":2,"aa":1}');
  });

  it("covers exact value discriminants and scalar rejection branches", () => {
    expectCode(() => create("machines", { identityKey: "", machineId: null }), "malformed-record");
    expectCode(() => create("machines", { identityKey: 1, machineId: null }), "malformed-record");
    expectCode(() => create("machines", {
      identityKey: MACHINE_IDENTITY,
      machineId: "018f7765-7b5c-6d92-8a2e-c6f6a15fca34",
    }), "malformed-record");
    expect(create("machines", {
      identityKey: MACHINE_IDENTITY,
      machineId: "018f7765-7b5c-7d92-8a2e-c6f6a15fca34",
    }).value.machineId).toBe("018f7765-7b5c-7d92-8a2e-c6f6a15fca34");
    expectCode(() => create("project", { identity: null }), "malformed-record");
    expectCode(() => create("project", { identity: { scope: "other", projectId: PROJECT_ID } }), "malformed-record");
    expectCode(() => create("messages", { ...representativeValues.messages, role: "other" }), "malformed-record");
    expectCode(() => create("messages", { ...representativeValues.messages, content: 1 }), "malformed-record");
    expectCode(() => create("message-parts", { ...representativeValues["message-parts"], isIgnored: "false" }), "malformed-record");
    expectCode(() => create("message-parts", { ...representativeValues["message-parts"], stepCost: Infinity }), "malformed-record");
    expectCode(() => create("message-parts", { ...representativeValues["message-parts"], stepCost: -1 }), "malformed-record");
    expectCode(() => create("native-transcripts", {
      ...representativeValues["native-transcripts"],
      nativePayload: "not-object-or-array",
    }), "malformed-record");
    expectCode(() => create("native-transcripts", {
      ...representativeValues["native-transcripts"],
      sourceLocator: "x".repeat(PORTABLE_LIMITS.maxControlBytes + 1),
    }), "record-unrepresentable");
    expectCode(() => create("conversations", {
      ...representativeValues.conversations,
      conversationFingerprint: HASH,
    }), "malformed-record");
    expectCode(() => create("conversations", {
      ...representativeValues.conversations,
      createdAt: new Date(Number.NaN),
    }), "malformed-record");
    expectCode(() => create("conversations", {
      ...representativeValues.conversations,
      createdAt: new Date(8.64e15),
    }), "malformed-record");
    expectCode(() => create("conversations", {
      ...representativeValues.conversations,
      occurrenceOrdinal: -1,
    }), "record-unrepresentable");
  });

  it("covers summary targets and alternate valid discriminants", () => {
    const summaryContextItem = create("context-items", {
      ...representativeValues["context-items"],
      itemType: "summary",
      messageIdentitySha256: null,
      summaryId: SUMMARY_ID,
    });
    expect(summaryContextItem.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "summaries" }),
    ]));
    expect(create("message-parts", {
      ...representativeValues["message-parts"],
      partType: "retry",
      stepCost: 0.5,
      isIgnored: null,
    })).toBeTruthy();
    expect(create("promoted-memories", {
      ...representativeValues["promoted-memories"],
      metadata: Object.create(null, { source: { value: "test", enumerable: true } }),
    })).toBeTruthy();
    expectCode(() => create("context-items", {
      ...representativeValues["context-items"],
      itemType: "summary",
      messageIdentitySha256: MESSAGE_ID,
      summaryId: null,
    }), "malformed-record");
  });

  it("covers remaining context and parser validation branches", () => {
    expectCode(() => create("messages", representativeValues.messages, 0, {
      conversationOrder: [...conversationOrder, 1],
    }), "malformed-record");
    expectCode(() => create("message-parts", representativeValues["message-parts"], 0, {
      messageOrder: messageOrder.slice(0, -1),
    }), "malformed-record");
    expectCode(() => create("context-items", {
      ...representativeValues["context-items"],
      conversationIdentitySha256: HASH,
    }), "malformed-record");

    const machine = create("machines", representativeValues.machines);
    const machineWire = JSON.parse(Buffer.from(bytes(machine)).toString("utf8")) as Record<string, unknown>;
    const malformedDependencyCases = [
      null,
      [{ domain: "machines", identitySha256: HASH }],
      [{ domain: "unknown", identitySha256: HASH }],
    ];
    for (const dependencies of malformedDependencyCases) {
      expectCode(() => parsePortableRecord(Buffer.from(`${referenceCanonicalJson({
        ...machineWire,
        dependencies,
      })}\n`)), "malformed-record");
    }

    const promoted = create("promoted-memories", representativeValues["promoted-memories"]);
    const promotedWire = JSON.parse(Buffer.from(bytes(promoted)).toString("utf8")) as Record<string, unknown>;
    expectCode(() => parsePortableRecord(Buffer.from(`${referenceCanonicalJson({
      ...promotedWire,
      dependencies: [],
    })}\n`)), "malformed-record");

    const message = create("messages", representativeValues.messages);
    const messageWire = JSON.parse(Buffer.from(bytes(message)).toString("utf8")) as Record<string, unknown>;
    expectCode(() => parsePortableRecord(Buffer.from(`${referenceCanonicalJson({
      ...messageWire,
      order: "not-an-array",
    })}\n`)), "malformed-record");
    expectCode(() => parsePortableRecord(Buffer.from(`${referenceCanonicalJson({
      ...messageWire,
      order: [],
    })}\n`)), "malformed-record");
    const part = create("message-parts", representativeValues["message-parts"]);
    const partWire = JSON.parse(Buffer.from(bytes(part)).toString("utf8")) as Record<string, unknown>;
    expectCode(() => parsePortableRecord(Buffer.from(`${referenceCanonicalJson({
      ...partWire,
      order: [],
    })}\n`)), "malformed-record");

    expectCode(() => parsePortableRecord(Uint8Array.from([0xff, 0x0a])), "malformed-record");
    expectCode(() => parsePortableRecord(Buffer.from("{\n")), "malformed-record");
    expectCode(() => parsePortableRecord(null as never), "malformed-record");
  });

  it("covers remaining canonical comparator and SQLite timestamp branches", () => {
    expect(comparePortableOrder([integer(2)], [integer(1)])).toBeGreaterThan(0);
    expect(comparePortableOrder([integer(1)], [integer(2)])).toBeLessThan(0);
    expect(canonicalJson({ "\u{10000}": 1, "\uE000": 2 })).toBe('{"𐀀":1,"":2}');
    expect(create("session-ingest", {
      ...representativeValues["session-ingest"],
      completedAt: "2026-08-13 12:34:56",
    }).value.completedAt).toBe("2026-08-13T12:34:56.000000Z");
  });

  it("changes canonical hashes when descriptor semantics change", () => {
    const digest = (descriptor: unknown) => sha256(canonicalJson(["lcm-portable-schema-v1", descriptor]));
    expect(digest(PORTABLE_RECORD_SCHEMA_DESCRIPTOR)).toBe(PORTABLE_RECORD_SCHEMA_SHA256);
    expect(digest({ ...PORTABLE_RECORD_SCHEMA_DESCRIPTOR, marker: "changed" })).not.toBe(PORTABLE_RECORD_SCHEMA_SHA256);
  });
});
