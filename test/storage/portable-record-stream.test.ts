import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as portableRecordStream from "../../src/storage/portable-record-stream.js";
import {
  PORTABLE_LIMITS,
  PORTABLE_RECORD_DOMAIN_ORDER,
  PORTABLE_RECORD_SCHEMA_SHA256,
  PortableStreamError,
  createPortableRecord,
  serializePortableRecord,
} from "../../src/storage/portable-record-stream.js";
import type {
  PortableDomain,
  PortableProjectIdentity,
  PortableRecord,
} from "../../src/storage/portable-record-stream.js";
import {
  createPortableBatch,
  createPortableManifest,
  createPortableRecordStream,
  negotiatePortableManifest,
  parsePortableCheckpoint,
  parsePortableManifest,
  serializePortableCheckpoint,
  serializePortableManifest,
  verifyPortableCheckpoint,
} from "../../src/storage/portable-record-stream.js";
import type {
  CreatePortableBatchInput,
  PortableBatch,
  PortableCheckpoint,
  PortableCoverageEvidence,
  PortableDomainManifest,
  PortableManifest,
  PortableReadBatchInput,
  PortableRecordSource,
  PortableRecordStream,
  PortableSourceDescription,
  PortableSourcePage,
  PortableSourcePageInput,
  PortableSourceVerificationInput,
  PortableVerification,
} from "../../src/storage/portable-record-stream.js";
import type {
  PortableRecordInput,
  PortableStreamErrorCode,
} from "../../src/storage/portable-record-stream.js";

const MACHINE_IDENTITY = "machine-616";
const PROJECT_ID = "a".repeat(64);
const HASH = "b".repeat(64);
const TIMESTAMP = "2026-08-13T12:34:56.123456Z";
const CAPTURED_AT = "2026-08-13T12:34:56.789000Z";
const SESSION_ID = "session-616";
const TITLE = "Portable stream conversation";
const PROJECT_IDENTITY: PortableProjectIdentity = Object.freeze({
  scope: "local",
  projectId: PROJECT_ID,
});

const integer = (value: string | number | bigint) => ({ $integer: String(value) });

/** Independent canonical JSON used for stream control hashes and golden vectors. */
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

function referenceSha256(value: string | Uint8Array | unknown): string {
  const bytes = typeof value === "string" || value instanceof Uint8Array
    ? value
    : Buffer.from(referenceCanonicalJson(value), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

function uint64be(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function appendLengthPrefixed(previousSha256: string, bytes: Uint8Array): string {
  return referenceSha256(Buffer.concat([
    Buffer.from(previousSha256, "hex"),
    Buffer.from(uint64be(bytes.byteLength)),
    Buffer.from(bytes),
  ]));
}

function initialDomainPrefix(schemaSha256: string, domain: PortableDomain): string {
  return referenceSha256(["lcm-portable-domain-v1", schemaSha256, domain, 1]);
}

function domainPrefix(schemaSha256: string, domain: PortableDomain, records: readonly PortableRecord[]): string {
  return records.reduce(
    (prefix, record) => appendLengthPrefixed(prefix, serializePortableRecord(record)),
    initialDomainPrefix(schemaSha256, domain),
  );
}

function aggregateContentSha256(schemaSha256: string, terminalDomainPrefixes: readonly string[]): string {
  const seed = referenceSha256(["lcm-portable-content-v1", schemaSha256]);
  return terminalDomainPrefixes.reduce(
    (digest, prefix) => appendLengthPrefixed(digest, Buffer.from(prefix, "hex")),
    seed,
  );
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      expectDeepFrozen(descriptor.value, seen);
    }
  }
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(PortableStreamError);
    expect((error as PortableStreamError).code).toBe(code);
    return;
  }
  throw new Error(`operation unexpectedly succeeded; expected ${code}`);
}

async function expectAsyncCode(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof PortableStreamError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`operation unexpectedly succeeded; expected ${code}`);
}

function expectSanitizedError(error: unknown, code: string, canaries: readonly string[] = []): void {
  expect(error).toBeInstanceOf(PortableStreamError);
  const portableError = error as PortableStreamError;
  expect(portableError.code).toBe(code);
  const serialized = JSON.stringify(portableError);
  for (const canary of canaries) {
    expect(serialized).not.toContain(canary);
    expect(portableError.stack ?? "").not.toContain(canary);
  }
  expect(Object.keys(JSON.parse(serialized))).toEqual(expect.arrayContaining([
    "name",
    "code",
    "retryable",
    "message",
  ]));
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const conversationFingerprint = referenceSha256([
  "lcm-portable-conversation-value-v1",
  SESSION_ID,
  TITLE,
  null,
  TIMESTAMP,
  TIMESTAMP,
]);
const conversationOrder = [SESSION_ID, TITLE, null, TIMESTAMP, TIMESTAMP, 0] as const;
const messageOrder = [...conversationOrder, 0] as const;
const conversationIdentitySha256 = referenceSha256([
  "lcm-portable-identity-v1",
  "conversations",
  [conversationFingerprint, integer(0)],
]);
const messageIdentitySha256 = referenceSha256([
  "lcm-portable-identity-v1",
  "messages",
  [conversationIdentitySha256, integer(0)],
]);
const projectIdentitySha256 = referenceSha256([
  "lcm-portable-identity-v1",
  "project",
  [PROJECT_IDENTITY.scope, PROJECT_IDENTITY.projectId],
]);

function nativeContext(value: Record<string, unknown>): Record<string, unknown> {
  const metadata = {
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
  };
  return {
    projectIdentity: PROJECT_IDENTITY,
    canonicalPayloadBytes: Buffer.byteLength(referenceCanonicalJson(value.nativePayload), "utf8"),
    canonicalMetadataBytes: Buffer.byteLength(referenceCanonicalJson(metadata), "utf8"),
  };
}

const contexts: Record<string, unknown> = {
  machines: null,
  project: null,
  "project-aliases": { projectIdentity: PROJECT_IDENTITY },
  conversations: { projectIdentity: PROJECT_IDENTITY },
  messages: { conversationOrder },
  "message-parts": { messageOrder },
  "large-files": null,
  summaries: null,
  "summary-file-links": null,
  "summary-message-links": null,
  "summary-parent-links": null,
  "context-items": { conversationOrder },
  "promoted-memories": { projectIdentity: PROJECT_IDENTITY },
  "promoted-memory-tags": null,
  "recall-surfacings": { projectIdentity: PROJECT_IDENTITY },
  "redaction-counters": { projectIdentity: PROJECT_IDENTITY },
  "session-ingest": { projectIdentity: PROJECT_IDENTITY },
  "session-instructions": { projectIdentity: PROJECT_IDENTITY },
  "native-transcripts": null,
  "native-transcript-message-links": null,
  "native-transcript-checkpoints": { projectIdentity: PROJECT_IDENTITY },
  "passive-events": { projectIdentity: PROJECT_IDENTITY },
};

const representativeValues: Record<string, Record<string, unknown>> = {
  machines: { identityKey: MACHINE_IDENTITY, machineId: null },
  project: { identity: PROJECT_IDENTITY },
  "project-aliases": {
    machineIdentityKey: MACHINE_IDENTITY,
    path: "/repo/project",
    normalizedPath: "/repo/project",
  },
  conversations: {
    conversationFingerprint,
    occurrenceOrdinal: 0,
    sessionId: SESSION_ID,
    createdAt: TIMESTAMP,
    title: TITLE,
    bootstrappedAt: null,
    updatedAt: TIMESTAMP,
  },
  messages: {
    conversationIdentitySha256,
    seq: 0,
    role: "user",
    content: "first message",
    tokenCount: 2,
    createdAt: TIMESTAMP,
  },
  "message-parts": {
    messageIdentitySha256,
    partId: "part-616",
    sessionId: SESSION_ID,
    partType: "text",
    ordinal: 0,
    textContent: "first message",
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
    fileId: "file-616",
    conversationIdentitySha256,
    fileName: "notes.txt",
    mimeType: "text/plain",
    byteSize: 5,
    storageUri: "memory://file-616",
    explorationSummary: null,
    createdAt: TIMESTAMP,
  },
  summaries: {
    summaryId: "summary-616",
    conversationIdentitySha256,
    kind: "leaf",
    depth: 0,
    content: "summary",
    tokenCount: 1,
    earliestAt: null,
    latestAt: TIMESTAMP,
    descendantCount: 0,
    descendantTokenCount: 0,
    sourceMessageTokenCount: 2,
    createdAt: TIMESTAMP,
  },
  "summary-file-links": { summaryId: "summary-616", ordinal: 0, fileId: "file-616" },
  "summary-message-links": { summaryId: "summary-616", ordinal: 0, messageIdentitySha256 },
  "summary-parent-links": { summaryId: "summary-616", ordinal: 0, parentSummaryId: "summary-parent-616" },
  "context-items": {
    conversationIdentitySha256,
    ordinal: 0,
    itemType: "message",
    messageIdentitySha256,
    summaryId: null,
    createdAt: TIMESTAMP,
  },
  "promoted-memories": {
    memoryId: "memory-616",
    content: "portable stream memory",
    metadata: { source: "task-2" },
    sourceProjectId: null,
    sourceSummaryId: null,
    sessionId: SESSION_ID,
    depth: 0,
    confidence: 0.5,
    createdAt: TIMESTAMP,
    archivedAt: null,
  },
  "promoted-memory-tags": { memoryId: "memory-616", ordinal: 0, tag: "portable" },
  "recall-surfacings": {
    memoryId: "memory-616",
    sessionId: null,
    surfacedAt: TIMESTAMP,
    occurrenceOrdinal: 0,
  },
  "redaction-counters": { category: "built_in", count: 0 },
  "session-ingest": { sessionId: SESSION_ID, messageCount: 2, completedAt: TIMESTAMP },
  "session-instructions": {
    machineIdentityKey: MACHINE_IDENTITY,
    scopeHash: HASH,
    clientName: "codex",
    sessionId: SESSION_ID,
    worktreePath: "/repo/project",
    cwdPath: "/repo/project/src",
    content: "portable stream instructions",
    contentHash: HASH,
    updatedAt: TIMESTAMP,
  },
  "native-transcripts": {
    machineIdentityKey: MACHINE_IDENTITY,
    clientName: "codex",
    formatName: "jsonl",
    formatVersion: "1",
    nativeSessionId: "native-session-616",
    sourceLocator: "/home/user/transcript-616.jsonl",
    sourceOrdinal: 0,
    observedAt: TIMESTAMP,
    ingestedAt: TIMESTAMP,
    scrubberVersion: "1",
    contentSha256: HASH,
    ingestKey: HASH,
    nativePayload: { content: "hello", role: "user" },
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
    sourceLocator: "/home/user/transcript-616.jsonl",
    revision: 0,
    lastSourceOrdinal: 0,
    importedCount: 1,
    skippedCount: 0,
    quarantinedCount: 0,
    checkpoint: { last: 0 },
    updatedAt: TIMESTAMP,
  },
  "passive-events": {
    machineIdentityKey: MACHINE_IDENTITY,
    eventId: "00000000-0000-7000-8000-000000000616",
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

function makeRecord(
  domain: string,
  value: Record<string, unknown>,
  ordinal = 0,
  context: unknown = contexts[domain],
): PortableRecord {
  const effectiveContext = domain === "native-transcripts" && context === null
    ? nativeContext(value)
    : context;
  return createPortableRecord({ domain, value, ordinal, context: effectiveContext } as never);
}

const records = Object.fromEntries(
  PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [
    domain,
    [makeRecord(
      domain,
      representativeValues[domain],
      0,
      domain === "native-transcripts" ? nativeContext(representativeValues[domain]) : contexts[domain],
    )],
  ]),
) as Record<PortableDomain, PortableRecord[]>;

const secondMessage = makeRecord("messages", {
  ...representativeValues.messages,
  seq: 1,
  content: "second message",
  tokenCount: 3,
}, 1, { conversationOrder });
records.messages = [records.messages[0], secondMessage];

function messageWithFramedBytes(ordinal: number, targetBytes: number): PortableRecord {
  const empty = makeRecord("messages", {
    ...representativeValues.messages,
    seq: ordinal,
    content: "",
    tokenCount: 0,
  }, ordinal, { conversationOrder });
  const emptyBytes = serializePortableRecord(empty).byteLength;
  expect(targetBytes).toBeGreaterThanOrEqual(emptyBytes);
  const record = makeRecord("messages", {
    ...representativeValues.messages,
    seq: ordinal,
    content: "x".repeat(targetBytes - emptyBytes),
    tokenCount: 0,
  }, ordinal, { conversationOrder });
  expect(serializePortableRecord(record).byteLength).toBe(targetBytes);
  return record;
}

function coverageEvidence(domain: PortableDomain, state: "available" | "authoritative-empty"): PortableCoverageEvidence {
  const evidenceSha256 = referenceSha256(["task-2-coverage", domain, state]);
  return state === "available"
    ? Object.freeze({ state, evidenceSha256 })
    : Object.freeze({ state, reason: "not-in-source-generation" as const, evidenceSha256 });
}

function makeCoverage(overrides: Partial<Record<PortableDomain, PortableCoverageEvidence>> = {}): Record<PortableDomain, PortableCoverageEvidence> {
  return Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [
    domain,
    overrides[domain] ?? coverageEvidence(domain, "available"),
  ])) as Record<PortableDomain, PortableCoverageEvidence>;
}

function makeSourceDescription(
  overrides: Partial<PortableSourceDescription> = {},
): PortableSourceDescription {
  return {
    capturedAt: CAPTURED_AT,
    sourceIdentitySha256: "1".repeat(64),
    sourceWitnessSha256: "2".repeat(64),
    coverage: makeCoverage(),
    ...overrides,
  };
}

function manifestDomainEntries(
  source: PortableSourceDescription,
  sourceRecords: Record<PortableDomain, readonly PortableRecord[]> = records,
): PortableDomainManifest[] {
  return PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => ({
    domain,
    domainVersion: 1 as const,
    coverage: source.coverage[domain],
    recordCount: sourceRecords[domain].length,
    prefixSha256: domainPrefix(PORTABLE_RECORD_SCHEMA_SHA256, domain, sourceRecords[domain]),
  }));
}

function makeManifestInput(
  source = makeSourceDescription(),
  sourceRecords: Record<PortableDomain, readonly PortableRecord[]> = records,
): Record<string, unknown> {
  const domains = manifestDomainEntries(source, sourceRecords);
  return {
    version: 1,
    schemaSha256: PORTABLE_RECORD_SCHEMA_SHA256,
    source,
    domains,
    contentSha256: aggregateContentSha256(
      PORTABLE_RECORD_SCHEMA_SHA256,
      domains.map((entry) => entry.prefixSha256),
    ),
    limits: PORTABLE_LIMITS,
  };
}

function makeManifest(
  source = makeSourceDescription(),
  sourceRecords: Record<PortableDomain, readonly PortableRecord[]> = records,
): PortableManifest {
  return createPortableManifest(makeManifestInput(source, sourceRecords) as never);
}

class FakePortableSource implements PortableRecordSource {
  readonly pageCalls: PortableSourcePageInput[] = [];
  readonly verifyCalls: PortableSourceVerificationInput[] = [];
  readonly description: PortableSourceDescription;
  readonly recordsByDomain: Record<PortableDomain, readonly PortableRecord[]>;
  verifyResult: "unchanged" | "changed" | "invalid" | "unavailable" = "unchanged";
  readFailure: Error | null = null;
  verifyFailure: Error | null = null;
  closeFailure: Error | null = null;
  pageFactory: ((input: PortableSourcePageInput) => PortableSourcePage | Promise<PortableSourcePage>) | null = null;
  readonly close = vi.fn(async () => {
    if (this.closeFailure !== null) throw this.closeFailure;
  });

  constructor(
    sourceRecords: Record<PortableDomain, readonly PortableRecord[]> = records,
    description = makeSourceDescription(),
  ) {
    this.recordsByDomain = sourceRecords;
    this.description = description;
  }

  describeSource(): PortableSourceDescription {
    return this.description;
  }

  async readDomainPage(input: PortableSourcePageInput): Promise<PortableSourcePage> {
    this.pageCalls.push({ ...input });
    if (this.readFailure !== null) throw this.readFailure;
    if (this.pageFactory !== null) return await this.pageFactory(input);

    const domainRecords = this.recordsByDomain[input.domain];
    const start = input.afterOrdinal;
    const selected: PortableRecord[] = [];
    let selectedBytes = 0;
    for (const record of domainRecords.slice(start)) {
      const recordBytes = serializePortableRecord(record).byteLength;
      if (selected.length > 0 && selectedBytes + recordBytes > input.maxBytes) break;
      if (selected.length >= input.maxRecords) break;
      selected.push(record);
      selectedBytes += recordBytes;
    }
    return {
      predecessor: input.includePredecessor && start > 0 ? domainRecords[start - 1] ?? null : null,
      records: selected,
      complete: start + selected.length >= domainRecords.length,
    };
  }

  async verifySource(input: PortableSourceVerificationInput): Promise<"unchanged" | "changed" | "invalid" | "unavailable"> {
    this.verifyCalls.push({ ...input });
    if (this.verifyFailure !== null) throw this.verifyFailure;
    return this.verifyResult;
  }
}

function sourceWithEmptyDomains(...domains: PortableDomain[]): FakePortableSource {
  const sourceRecords = { ...records } as Record<PortableDomain, readonly PortableRecord[]>;
  const coverage = makeCoverage(Object.fromEntries(domains.map((domain) => [domain, coverageEvidence(domain, "authoritative-empty")])) as never);
  for (const domain of domains) sourceRecords[domain] = [];
  return new FakePortableSource(sourceRecords, makeSourceDescription({ coverage }));
}

function createBatchInput(
  manifest: PortableManifest,
  domain: PortableDomain,
  page: PortableSourcePage,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    manifest,
    domain,
    page,
    priorCheckpoint: undefined,
    maxRecords: PORTABLE_LIMITS.maxBatchRecords,
    maxBytes: PORTABLE_LIMITS.maxBatchBytes,
    ...overrides,
  };
}

function asPortableBatch(value: unknown): PortableBatch {
  return value as PortableBatch;
}

function withCheckpointChecksum(
  checkpoint: PortableCheckpoint,
  overrides: Partial<PortableCheckpoint>,
): PortableCheckpoint {
  const body = { ...checkpoint, ...overrides } as Record<string, unknown>;
  delete body.checkpointSha256;
  return {
    ...body,
    checkpointSha256: referenceSha256(body),
  } as unknown as PortableCheckpoint;
}

describe("portable record stream public seam", () => {
  it("re-exports the Task 1 consumer seam from the stream module", () => {
    const recordInput: PortableRecordInput<"machines"> = {
      domain: "machines",
      ordinal: 0,
      value: { identityKey: "stream-only-import", machineId: null },
      context: null,
    };
    const errorCode: PortableStreamErrorCode = "aborted";
    const record = portableRecordStream.createPortableRecord(recordInput);
    const manifest = makeManifest();
    const batchInput: CreatePortableBatchInput = {
      manifest,
      domain: "machines",
      page: { predecessor: null, records: [records.machines[0]], complete: true },
      maxRecords: PORTABLE_LIMITS.maxBatchRecords,
      maxBytes: PORTABLE_LIMITS.maxBatchBytes,
    };

    expect(portableRecordStream.parsePortableRecord(
      portableRecordStream.serializePortableRecord(record),
    )).toEqual(record);
    expect(portableRecordStream.canonicalJson({ errorCode })).toBe('{"errorCode":"aborted"}');
    expect(createPortableBatch(batchInput).records).toEqual([records.machines[0]]);
  });

  it("freezes the exact 22-domain inventory and fixed limits", () => {
    expect(PORTABLE_RECORD_DOMAIN_ORDER).toHaveLength(22);
    expect(PORTABLE_LIMITS).toEqual({
      maxJsonDepth: 100,
      maxRecordBytes: 128 * 1024 * 1024,
      maxBatchRecords: 500,
      maxBatchBytes: 144 * 1024 * 1024,
      maxControlBytes: 1024 * 1024,
    });
    expect(Object.isFrozen(PORTABLE_LIMITS)).toBe(true);
    expect(Object.isFrozen(PORTABLE_RECORD_DOMAIN_ORDER)).toBe(true);
  });

  it("derives the eight-byte length-prefixed domain and aggregate golden vectors independently", () => {
    const schema = "1".repeat(64);
    const initial = initialDomainPrefix(schema, "project");
    const recordBytes = Buffer.from("record-vector", "utf8");
    const updated = appendLengthPrefixed(initial, recordBytes);
    const aggregate = aggregateContentSha256(schema, [initial, updated]);

    expect(Buffer.from(uint64be(recordBytes.byteLength)).toString("hex")).toBe("000000000000000d");
    expect(initial).toBe("e33ffdba16b583134ee96f4c4dcf0075b3443d017253d3ebd61963cd1f8d2461");
    expect(updated).toBe("85db25e3c7d7c7cd936aa2ec60b6558b918a128bd0442106802f41ba838af3e0");
    expect(aggregate).toBe("6cd58fbc3eac32d1a9fdea04262fc5c82770c1ed5d994ff25b9ae8fc51c2bf44");
  });

  it("constructs a complete manifest with every domain exactly once and self-hashes it", () => {
    const source = makeSourceDescription();
    const manifest = makeManifest(source);
    expect(manifest).toMatchObject({
      version: 1,
      schemaSha256: PORTABLE_RECORD_SCHEMA_SHA256,
      source,
      limits: PORTABLE_LIMITS,
    });
    expect(manifest.domains).toHaveLength(22);
    expect(manifest.domains.map((entry) => entry.domain)).toEqual(PORTABLE_RECORD_DOMAIN_ORDER);
    expect(manifest.domains.map((entry) => entry.domainVersion)).toEqual(new Array(22).fill(1));
    const withoutChecksum = { ...manifest } as Record<string, unknown>;
    delete withoutChecksum.manifestSha256;
    expect(manifest.manifestSha256).toBe(referenceSha256(withoutChecksum));
    expectDeepFrozen(manifest);
  });

  it("requires one canonical six-digit UTC capturedAt dialect", () => {
    const canonical = makeSourceDescription({ capturedAt: "2026-08-13T12:34:56.789000Z" });
    expect(() => createPortableManifest(makeManifestInput(canonical) as never)).not.toThrow();
    expectCode(
      () => createPortableManifest(makeManifestInput(makeSourceDescription({ capturedAt: null as never })) as never),
      "malformed-manifest",
    );
    for (const capturedAt of [
      "2026-08-13T12:34:56.789Z",
      "2026-08-13T12:34:56.789000+00:00",
      "2026-02-30T12:34:56.789000Z",
    ]) {
      expectCode(
        () => createPortableManifest(makeManifestInput(makeSourceDescription({ capturedAt })) as never),
        "malformed-manifest",
      );
    }
  });

  it("serializes and parses a manifest with canonical bytes, exact hashes, and immutable output", () => {
    const manifest = makeManifest();
    const serialized = serializePortableManifest(manifest);
    const text = Buffer.from(serialized).toString("utf8");
    expect(text).toBe(`${referenceCanonicalJson(manifest)}\n`);
    const parsed = parsePortableManifest(serialized);
    expect(parsed).toEqual(manifest);
    expectDeepFrozen(parsed);
  });

  it.each([
    ["unsupported-version", (manifest: PortableManifest) => ({ ...manifest, version: 2 })],
    ["incompatible-schema", (manifest: PortableManifest) => ({ ...manifest, schemaSha256: HASH })],
    ["invalid-limit", (manifest: PortableManifest) => ({ ...manifest, limits: { ...PORTABLE_LIMITS, maxBatchRecords: 1 } })],
    ["malformed-manifest", (manifest: PortableManifest) => ({ ...manifest, domains: manifest.domains.slice(1) })],
  ] as const)("rejects %s before accepting a manifest", (code, mutate) => {
    const manifest = makeManifest();
    const tampered = mutate(manifest);
    const bytes = Buffer.from(`${referenceCanonicalJson(tampered)}\n`, "utf8");
    expectCode(() => parsePortableManifest(bytes), code);
  });

  it("rejects duplicate, reordered, unknown, or incomplete domain inventory and coverage drift", () => {
    const manifest = makeManifest();
    const duplicate = [...manifest.domains.slice(0, -1), manifest.domains[0]];
    expectCode(() => parsePortableManifest(Buffer.from(`${referenceCanonicalJson({ ...manifest, domains: duplicate })}\n`)), "malformed-manifest");
    const reordered = [manifest.domains[1], manifest.domains[0], ...manifest.domains.slice(2)];
    expectCode(() => parsePortableManifest(Buffer.from(`${referenceCanonicalJson({ ...manifest, domains: reordered })}\n`)), "malformed-manifest");
    const unknown = [{ ...manifest.domains[0], domain: "unknown" }, ...manifest.domains.slice(1)];
    expectCode(() => parsePortableManifest(Buffer.from(`${referenceCanonicalJson({ ...manifest, domains: unknown })}\n`)), "malformed-manifest");
    const wrongCoverage = {
      ...manifest,
      source: {
        ...manifest.source,
        coverage: {
          ...manifest.source.coverage,
          project: { state: "authoritative-empty", reason: "not-in-source-generation", evidenceSha256: HASH },
        },
      },
    };
    expectCode(() => parsePortableManifest(Buffer.from(`${referenceCanonicalJson(wrongCoverage)}\n`)), "malformed-manifest");
  });

  it("negotiates exact v1 schema, inventory, and immutable limits without caller downgrade", () => {
    const manifest = makeManifest();
    expect(negotiatePortableManifest(manifest as never)).toEqual(manifest);
    expectCode(() => negotiatePortableManifest({ ...manifest, version: 2 } as never), "unsupported-version");
    expectCode(() => negotiatePortableManifest({ ...manifest, schemaSha256: HASH } as never), "incompatible-schema");
    expectCode(() => negotiatePortableManifest(manifest as never, {
      version: 1,
      schemaSha256: PORTABLE_RECORD_SCHEMA_SHA256,
      limits: { ...PORTABLE_LIMITS, maxBatchRecords: 1 },
    } as never), "invalid-limit");
  });

  it("rejects hostile manifest shapes and preserves fixed validation errors", () => {
    const input = makeManifestInput();
    const nullPrototypeInput = Object.assign(Object.create(null) as Record<string, unknown>, input);
    expect(createPortableManifest(nullPrototypeInput as never)).toMatchObject({ version: 1 });
    expectCode(() => createPortableManifest(null as never), "malformed-manifest");
    expectCode(() => createPortableManifest(Object.assign(Object.create({}), input) as never), "malformed-manifest");
    expectCode(() => createPortableManifest({ ...input, unexpected: true } as never), "malformed-manifest");
    expectCode(() => createPortableManifest({ ...input, domains: {} } as never), "malformed-manifest");

    const extraArrayKey = [...(input.domains as unknown[])] as unknown[] & { extra?: boolean };
    extraArrayKey.extra = true;
    expectCode(() => createPortableManifest({ ...input, domains: extraArrayKey } as never), "malformed-manifest");

    const throwingPrototype = new Proxy(input, {
      getPrototypeOf: () => { throw new Error("prototype canary"); },
    });
    expectCode(() => createPortableManifest(throwingPrototype as never), "malformed-manifest");
    const throwingKeys = new Proxy(input, {
      getPrototypeOf: () => Object.prototype,
      ownKeys: () => { throw new Error("keys canary"); },
    });
    expectCode(() => createPortableManifest(throwingKeys as never), "malformed-manifest");

    const accessor = { ...input };
    Object.defineProperty(accessor, "version", { configurable: true, enumerable: true, get: () => 1 });
    expectCode(() => createPortableManifest(accessor as never), "malformed-manifest");
    const missingDescriptor = new Proxy(input, {
      getOwnPropertyDescriptor: (target, key) => key === "version"
        ? undefined
        : Object.getOwnPropertyDescriptor(target, key),
    });
    expectCode(() => createPortableManifest(missingDescriptor as never), "malformed-manifest");
    const ordinaryDescriptorError = new Proxy(input, {
      getOwnPropertyDescriptor: (target, key) => {
        if (key === "version") throw new Error("descriptor canary");
        return Object.getOwnPropertyDescriptor(target, key);
      },
    });
    expectCode(() => createPortableManifest(ordinaryDescriptorError as never), "malformed-manifest");
    const portableDescriptorError = new Proxy(input, {
      getOwnPropertyDescriptor: (target, key) => {
        if (key === "version") throw new PortableStreamError("malformed-manifest");
        return Object.getOwnPropertyDescriptor(target, key);
      },
    });
    expectCode(() => createPortableManifest(portableDescriptorError as never), "malformed-manifest");

    const badSourceShape = makeSourceDescription({
      coverage: { ...makeCoverage(), project: null as never },
    });
    expectCode(() => createPortableManifest(makeManifestInput(badSourceShape) as never), "malformed-manifest");
    const badAvailableEvidence = makeSourceDescription({
      coverage: makeCoverage({ project: { state: "available", evidenceSha256: "bad" } as never }),
    });
    expectCode(() => createPortableManifest(makeManifestInput(badAvailableEvidence) as never), "malformed-manifest");
    const badCoverageState = makeSourceDescription({
      coverage: makeCoverage({ project: { state: "unsupported", evidenceSha256: HASH } as never }),
    });
    expectCode(() => createPortableManifest(makeManifestInput(badCoverageState) as never), "malformed-manifest");
    expectCode(() => createPortableManifest(makeManifestInput(makeSourceDescription({ capturedAt: "not-a-time" })) as never), "malformed-manifest");
    expectCode(() => createPortableManifest({ ...input, contentSha256: "not-a-hash" } as never), "malformed-manifest");
    expectCode(() => createPortableManifest({
      ...input,
      domains: (input.domains as PortableDomainManifest[]).map((entry, index) => index === 0
        ? { ...entry, prefixSha256: HASH }
        : entry),
      contentSha256: HASH,
    } as never), "malformed-manifest");

    const manifest = makeManifest();
    expectCode(() => negotiatePortableManifest(manifest, {
      version: 2,
      schemaSha256: PORTABLE_RECORD_SCHEMA_SHA256,
      limits: PORTABLE_LIMITS,
    } as never), "unsupported-version");
    expectCode(() => negotiatePortableManifest(manifest, {
      version: 1,
      schemaSha256: HASH,
      limits: PORTABLE_LIMITS,
    } as never), "incompatible-schema");
  });

  it("keeps source description coverage complete and rejects unsupported empty claims", async () => {
    const source = sourceWithEmptyDomains("native-transcripts", "native-transcript-message-links", "native-transcript-checkpoints");
    const stream = await createPortableRecordStream(source);
    const manifest = stream.describe();
    expect(manifest.source.coverage["native-transcripts"]).toMatchObject({
      state: "authoritative-empty",
      reason: "not-in-source-generation",
    });
    expect(source.pageCalls.some((call) => call.domain === "native-transcripts")).toBe(false);
    await stream.close();

    const unsupported = new FakePortableSource(records, makeSourceDescription({
      coverage: makeCoverage({
        "native-transcripts": { state: "authoritative-empty", reason: "not-in-source-generation", evidenceSha256: "" } as never,
      }),
    }));
    unsupported.verifyResult = "invalid";
    await expectAsyncCode(() => createPortableRecordStream(unsupported), "source-invalid");
  });

  it("rejects duplicate projects and binds every opaque project dependency to the one project identity", async () => {
    const duplicateProject = makeRecord("project", { identity: { scope: "local", projectId: "c".repeat(64) } }, 1);
    const sourceRecords = { ...records, project: [records.project[0], duplicateProject] };
    await expectAsyncCode(() => createPortableRecordStream(new FakePortableSource(sourceRecords)), "source-invalid");

    const wrongProjectDependency = { ...records["promoted-memories"][0], dependencies: [{ domain: "project", identitySha256: HASH }] };
    const tamperedSource = new FakePortableSource({ ...records, "promoted-memories": [wrongProjectDependency] });
    await expectAsyncCode(() => createPortableRecordStream(tamperedSource), "source-invalid");
  });

  it("performs a bounded manifest pre-pass and a second bounded transfer pass with witness checks", async () => {
    const source = new FakePortableSource();
    const stream = await createPortableRecordStream(source);
    const manifest = stream.describe();
    expect(source.pageCalls.length).toBeGreaterThanOrEqual(22);
    expect(source.pageCalls.every((input) => input.maxRecords === 500 && input.maxBytes === 144 * 1024 * 1024)).toBe(true);
    const batch = await stream.readBatch({ domain: "messages", maxRecords: 1, maxBytes: 1_000_000 });
    expect(batch.records).toHaveLength(1);
    expect(batch.records[0].domain).toBe("messages");
    expect(source.pageCalls.at(-1)).toMatchObject({ domain: "messages", maxRecords: 500, maxBytes: 144 * 1024 * 1024 });
    expect(source.verifyCalls.some((input) => input.manifestSha256 === manifest.manifestSha256)).toBe(true);
    expect(source.verifyCalls.every((input) => input.sourceWitnessSha256 === manifest.source.sourceWitnessSha256)).toBe(true);
    await stream.close();
  });

  it("does not retain identity state beyond one bounded source page during the manifest pre-pass", async () => {
    const machineRecords = Array.from({ length: PORTABLE_LIMITS.maxBatchRecords + 1 }, (_, ordinal) => makeRecord(
      "machines",
      { identityKey: `machine-${String(ordinal).padStart(4, "0")}`, machineId: null },
      ordinal,
      null,
    ));
    const source = new FakePortableSource({ ...records, machines: machineRecords });
    const NativeSet = globalThis.Set;
    class PageBoundedSet<T> extends NativeSet<T> {
      private identityCount = 0;

      override add(value: T): this {
        if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) {
          this.identityCount += 1;
          if (this.identityCount > PORTABLE_LIMITS.maxBatchRecords) {
            throw new Error("manifest pre-pass retained identities across pages");
          }
        }
        return super.add(value);
      }
    }

    let stream: PortableRecordStream | undefined;
    globalThis.Set = PageBoundedSet as SetConstructor;
    try {
      stream = await createPortableRecordStream(source);
    } finally {
      globalThis.Set = NativeSet;
    }
    if (stream === undefined) throw new Error("stream was not created");
    expect(source.pageCalls.filter((call) => call.domain === "machines")).toHaveLength(2);
    await stream.close();
  });

  it.each([
    {
      name: "duplicate identity",
      first: makeRecord("messages", representativeValues.messages, 0, { conversationOrder }),
      second: makeRecord("messages", representativeValues.messages, 1, { conversationOrder }),
    },
    {
      name: "order regression",
      first: makeRecord("messages", { ...representativeValues.messages, seq: 1 }, 0, { conversationOrder }),
      second: makeRecord("messages", representativeValues.messages, 1, { conversationOrder }),
    },
  ])("rejects a $name crossing a manifest page boundary", async ({ first, second }) => {
    const source = new FakePortableSource();
    source.pageFactory = (input) => {
      if (input.domain !== "messages") {
        return { predecessor: null, records: source.recordsByDomain[input.domain], complete: true };
      }
      return input.afterOrdinal === 0
        ? { predecessor: null, records: [first], complete: false }
        : { predecessor: first, records: [second], complete: true };
    };
    await expectAsyncCode(() => createPortableRecordStream(source), "source-invalid");
  });

  it("accepts an available domain with an authenticated empty page", async () => {
    const source = new FakePortableSource({ ...records, machines: [] });
    const stream = await createPortableRecordStream(source);
    const machines = stream.describe().domains[0];
    expect(machines).toMatchObject({ domain: "machines", recordCount: 0 });
    expect(machines.coverage.state).toBe("available");
    expect(source.pageCalls.filter((call) => call.domain === "machines")).toHaveLength(1);
    await stream.close();
  });

  it("rejects source witness drift before returning a manifest", async () => {
    const source = new FakePortableSource();
    source.verifyResult = "changed";
    await expectAsyncCode(() => createPortableRecordStream(source), "source-changed");
    expect(source.pageCalls.length).toBeGreaterThan(0);
  });

  it("normalizes hostile source descriptions and pages before exposing a stream", async () => {
    const throwingDescription = new FakePortableSource();
    throwingDescription.describeSource = () => { throw new Error("source description canary"); };
    await expectAsyncCode(() => createPortableRecordStream(throwingDescription), "source-unavailable");

    const portableReadFailure = new FakePortableSource();
    portableReadFailure.readFailure = new PortableStreamError("malformed-record");
    await expectAsyncCode(() => createPortableRecordStream(portableReadFailure), "source-invalid");

    const expectInvalidPage = async (page: unknown): Promise<void> => {
      const source = new FakePortableSource();
      source.pageFactory = () => page as PortableSourcePage;
      await expectAsyncCode(() => createPortableRecordStream(source), "source-invalid");
    };
    await expectInvalidPage(null);
    await expectInvalidPage({ predecessor: null, records: [], complete: "yes" });
    await expectInvalidPage({ predecessor: null, records: [], complete: false });
    await expectInvalidPage({
      predecessor: null,
      records: new Array(PORTABLE_LIMITS.maxBatchRecords + 1).fill(records.messages[0]),
      complete: true,
    });
    await expectInvalidPage({ predecessor: {}, records: [], complete: true });
    await expectInvalidPage({ predecessor: records.messages[0], records: [], complete: true });
    await expectInvalidPage({ predecessor: null, records: [{}], complete: true });

    const predecessorMismatch = new FakePortableSource();
    let messagePage = 0;
    predecessorMismatch.pageFactory = (input) => {
      if (input.domain === "messages") {
        messagePage += 1;
        return messagePage === 1
          ? { predecessor: null, records: [records.messages[0]], complete: false }
          : { predecessor: null, records: [records.messages[1]], complete: true };
      }
      return {
        predecessor: null,
        records: predecessorMismatch.recordsByDomain[input.domain],
        complete: true,
      };
    };
    await expectAsyncCode(() => createPortableRecordStream(predecessorMismatch), "source-invalid");

    const emptyProject = sourceWithEmptyDomains("project");
    await expectAsyncCode(() => createPortableRecordStream(emptyProject), "source-invalid");

    const duplicateProject = makeRecord("project", { identity: { scope: "local", projectId: "c".repeat(64) } }, 1);
    const pagedDuplicate = new FakePortableSource();
    let projectPage = 0;
    pagedDuplicate.pageFactory = (input) => {
      if (input.domain === "project") {
        projectPage += 1;
        return projectPage === 1
          ? { predecessor: null, records: [records.project[0]], complete: false }
          : { predecessor: records.project[0], records: [duplicateProject], complete: true };
      }
      return {
        predecessor: null,
        records: pagedDuplicate.recordsByDomain[input.domain],
        complete: true,
      };
    };
    await expectAsyncCode(() => createPortableRecordStream(pagedDuplicate), "source-invalid");

    const wrongProject = makeRecord(
      "promoted-memories",
      representativeValues["promoted-memories"],
      0,
      { projectIdentity: { scope: "local", projectId: "b".repeat(64) } },
    );
    await expectAsyncCode(() => createPortableRecordStream(new FakePortableSource({
      ...records,
      "promoted-memories": [wrongProject],
    })), "source-invalid");

    const driftedDescription = new FakePortableSource();
    let descriptionCalls = 0;
    driftedDescription.describeSource = () => {
      descriptionCalls += 1;
      return descriptionCalls === 1
        ? driftedDescription.description
        : { ...driftedDescription.description, sourceWitnessSha256: "3".repeat(64) };
    };
    await expectAsyncCode(() => createPortableRecordStream(driftedDescription), "source-changed");
  });

  it("creates initial, resumed, partial, and final batches with predecessor excluded from budgets", () => {
    const manifest = makeManifest();
    const first = asPortableBatch(createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: null,
      records: [records.messages[0]],
      complete: false,
    }, { maxRecords: 1, maxBytes: 1_000_000 })));
    expect(first.records).toEqual([records.messages[0]]);
    expect(first.checkpoint.nextOrdinal).toBe(1);
    expect(first.checkpoint.recordCount).toBe(1);
    expect(first.checkpoint.previousCheckpointSha256).toBeNull();
    expect(first.complete).toBe(false);

    const resumed = asPortableBatch(createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: records.messages[0],
      records: [records.messages[1]],
      complete: true,
    }, {
      priorCheckpoint: first.checkpoint,
      maxRecords: 1,
      maxBytes: serializePortableRecord(records.messages[1]).byteLength,
    })));
    expect(resumed.records).toEqual([records.messages[1]]);
    expect(resumed.checkpoint.nextOrdinal).toBe(2);
    expect(resumed.checkpoint.recordCount).toBe(2);
    expect(resumed.checkpoint.previousCheckpointSha256).toBe(first.checkpoint.checkpointSha256);
    expect(resumed.complete).toBe(true);
    expect(resumed.framedBytes).toBe(serializePortableRecord(records.messages[1]).byteLength);
  });

  it("accepts an empty terminal page and rejects an empty nonterminal page", () => {
    const manifest = makeManifest(makeSourceDescription(), {
      ...records,
      "redaction-counters": [],
    });
    const first = asPortableBatch(createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: null,
      records: [records.messages[0]],
      complete: false,
    }, { maxRecords: 1, maxBytes: PORTABLE_LIMITS.maxBatchBytes })));
    const prior = asPortableBatch(createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: records.messages[0],
      records: [records.messages[1]],
      complete: true,
    }, {
      priorCheckpoint: first.checkpoint,
      maxRecords: 1,
      maxBytes: PORTABLE_LIMITS.maxBatchBytes,
    })));
    expect(prior.complete).toBe(true);
    const emptyTerminal = asPortableBatch(createPortableBatch(createBatchInput(manifest, "redaction-counters", {
      predecessor: null,
      records: [],
      complete: true,
    })));
    expect(emptyTerminal.records).toEqual([]);
    expect(emptyTerminal.checkpoint.nextOrdinal).toBe(0);
    expect(emptyTerminal.complete).toBe(true);
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: records.messages[1],
      records: [],
      complete: false,
    }, { priorCheckpoint: prior.checkpoint })), "partial-batch");
  });

  it("rejects incomplete checkpoints and pages at terminal boundaries", () => {
    const emptyManifest = makeManifest(makeSourceDescription(), {
      ...records,
      "redaction-counters": [],
    });
    const emptyTerminal = asPortableBatch(createPortableBatch(createBatchInput(emptyManifest, "redaction-counters", {
      predecessor: null,
      records: [],
      complete: true,
    })));
    const forgedIncomplete = withCheckpointChecksum(emptyTerminal.checkpoint, { complete: false });
    expectCode(() => verifyPortableCheckpoint(forgedIncomplete, emptyManifest), "checkpoint-mismatch");

    const nonemptyManifest = makeManifest(makeSourceDescription(), {
      ...records,
      messages: [records.messages[0]],
    });
    expectCode(() => createPortableBatch(createBatchInput(nonemptyManifest, "messages", {
      predecessor: null,
      records: [records.messages[0]],
      complete: false,
    })), "partial-batch");
  });

  it("rejects source pages that over-return the global record count regardless of predecessor", () => {
    const manifest = makeManifest();
    const overCount = Array.from({ length: PORTABLE_LIMITS.maxBatchRecords + 1 }, (_, ordinal) =>
      makeRecord("messages", { ...representativeValues.messages, seq: ordinal, content: `message-${ordinal}` }, ordinal, { conversationOrder }));
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: records.messages[0],
      records: overCount,
      complete: false,
    })), "batch-limit-exceeded");
  });

  it("uses global source caps while enforcing lower caller record and byte caps", async () => {
    const source = new FakePortableSource();
    const stream = await createPortableRecordStream(source);
    await expectAsyncCode(() => stream.readBatch({
      domain: "messages",
      maxRecords: 1,
      maxBytes: 1,
    }), "batch-limit-exceeded");
    expect(source.pageCalls.at(-1)).toMatchObject({
      maxRecords: PORTABLE_LIMITS.maxBatchRecords,
      maxBytes: PORTABLE_LIMITS.maxBatchBytes,
    });
    await stream.close();
  });

  it("accepts an actual predecessor outside the caller record and byte budgets", () => {
    const manifest = makeManifest();
    const first = asPortableBatch(createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: null,
      records: [records.messages[0]],
      complete: false,
    }, { maxRecords: 1, maxBytes: PORTABLE_LIMITS.maxBatchBytes })));
    const record = records.messages[1];
    const recordBytes = serializePortableRecord(record).byteLength;
    const batch = asPortableBatch(createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: records.messages[0],
      records: [record],
      complete: true,
    }, {
      priorCheckpoint: first.checkpoint,
      maxRecords: 1,
      maxBytes: recordBytes,
    })));
    expect(batch.framedBytes).toBe(recordBytes);
    expect(batch.records).toHaveLength(1);
  });

  it("accepts records exactly filling 144 MiB with a valid predecessor excluded", () => {
    const predecessor = records.messages[0];
    const first = messageWithFramedBytes(1, PORTABLE_LIMITS.maxRecordBytes);
    const second = messageWithFramedBytes(
      2,
      PORTABLE_LIMITS.maxBatchBytes - PORTABLE_LIMITS.maxRecordBytes,
    );
    const sourceRecords = { ...records, messages: [predecessor, first, second] };
    const manifest = makeManifest(makeSourceDescription(), sourceRecords);
    const prior = asPortableBatch(createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: null,
      records: [predecessor],
      complete: false,
    }, {
      maxRecords: 1,
      maxBytes: PORTABLE_LIMITS.maxBatchBytes,
    })));
    const batch = asPortableBatch(createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor,
      records: [first, second],
      complete: true,
    }, {
      priorCheckpoint: prior.checkpoint,
      maxRecords: 2,
      maxBytes: PORTABLE_LIMITS.maxBatchBytes,
    })));
    expect(batch.framedBytes).toBe(PORTABLE_LIMITS.maxBatchBytes);
    expect(batch.records).toEqual([first, second]);
    expect(batch.complete).toBe(true);
  }, 180_000);

  it("rejects records totaling 144 MiB plus one with a valid predecessor excluded", () => {
    const predecessor = records.messages[0];
    const first = messageWithFramedBytes(1, PORTABLE_LIMITS.maxRecordBytes);
    const second = messageWithFramedBytes(
      2,
      PORTABLE_LIMITS.maxBatchBytes - PORTABLE_LIMITS.maxRecordBytes + 1,
    );
    const sourceRecords = { ...records, messages: [predecessor, first, second] };
    const manifest = makeManifest(makeSourceDescription(), sourceRecords);
    const prior = asPortableBatch(createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: null,
      records: [predecessor],
      complete: false,
    }, {
      maxRecords: 1,
      maxBytes: PORTABLE_LIMITS.maxBatchBytes,
    })));
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor,
      records: [first, second],
      complete: true,
    }, {
      priorCheckpoint: prior.checkpoint,
      maxRecords: 2,
      maxBytes: PORTABLE_LIMITS.maxBatchBytes,
    })), "batch-limit-exceeded");
    expect(prior.checkpoint.nextOrdinal).toBe(1);
  }, 120_000);

  it("rejects the first record above a lower caller byte limit without advancing the prior checkpoint", () => {
    const manifest = makeManifest();
    const first = asPortableBatch(createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: null,
      records: [records.messages[0]],
      complete: false,
    }, { maxRecords: 1, maxBytes: PORTABLE_LIMITS.maxBatchBytes })));
    const prior = first.checkpoint;
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: records.messages[0],
      records: [records.messages[1]],
      complete: false,
    }, {
      priorCheckpoint: prior,
      maxRecords: 1,
      maxBytes: 1,
    })), "batch-limit-exceeded");
    expect(prior).toEqual(first.checkpoint);
  });

  it.each([
    ["duplicate-identity", [records.messages[0], records.messages[0]]],
    ["order-regression", [records.messages[1], records.messages[0]]],
  ] as const)("rejects %s in one page", (code, pageRecords) => {
    const manifest = makeManifest();
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: null,
      records: pageRecords,
      complete: false,
    })), code);
  });

  it("rejects predecessor equality, wrong domain, ordinal gaps, and mismatched predecessor digests", () => {
    const manifest = makeManifest();
    const first = asPortableBatch(createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: null,
      records: [records.messages[0]],
      complete: false,
    })));
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: records.messages[0],
      records: [records.messages[0]],
      complete: false,
    }, { priorCheckpoint: first.checkpoint })), "order-regression");
    expectCode(() => createPortableBatch(createBatchInput(manifest, "project", {
      predecessor: null,
      records: [records.project[0]],
      complete: true,
    }, { priorCheckpoint: first.checkpoint })), "checkpoint-mismatch");
    const gapped = makeRecord("messages", { ...representativeValues.messages, seq: 1, content: "gap" }, 2, { conversationOrder });
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: records.messages[0],
      records: [gapped],
      complete: false,
    }, { priorCheckpoint: first.checkpoint })), "checkpoint-mismatch");
    const forged = { ...first.checkpoint, lastRecordSha256: HASH };
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: records.messages[0],
      records: [records.messages[1]],
      complete: true,
    }, { priorCheckpoint: forged })), "checkpoint-mismatch");
  });

  it("rejects invalid batch inputs and dependency contracts at the public seam", () => {
    const manifest = makeManifest();
    const page = {
      predecessor: null,
      records: [records.messages[0]],
      complete: false,
    };
    expectCode(() => createPortableBatch(createBatchInput(manifest, "unknown" as never, page)), "unknown-domain");
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", page, { maxRecords: 0 })), "invalid-limit");
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", page, { maxBytes: 0 })), "invalid-limit");
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      ...page,
      complete: "yes",
    } as never)), "partial-batch");
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: null,
      records: [null],
      complete: false,
    } as never)), "malformed-record");
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: null,
      records: [],
      complete: false,
    })), "partial-batch");
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: records.messages[0],
      records: [records.messages[1]],
      complete: false,
    })), "checkpoint-mismatch");

    const emptyDependencies = { ...records.messages[0], dependencies: [] };
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: null,
      records: [emptyDependencies],
      complete: false,
    })), "dependency-order");
    const unexpectedProjectDependency = { ...records.project[0], dependencies: [{ domain: "project", identitySha256: PROJECT_IDENTITY }] };
    expectCode(() => createPortableBatch(createBatchInput(manifest, "project", {
      predecessor: null,
      records: [unexpectedProjectDependency],
      complete: true,
    })), "dependency-order");
    const missingDependency = {
      ...records["session-instructions"][0],
      dependencies: [records["session-instructions"][0].dependencies[0]],
    };
    expectCode(() => createPortableBatch(createBatchInput(manifest, "session-instructions", {
      predecessor: null,
      records: [missingDependency],
      complete: false,
    })), "dependency-order");

    expectCode(() => createPortableBatch(createBatchInput(manifest, "machines", {
      predecessor: null,
      records: [records.project[0]],
      complete: false,
    })), "checkpoint-mismatch");
    const first = asPortableBatch(createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: null,
      records: [records.messages[0]],
      complete: false,
    })));
    const forgedPrior = withCheckpointChecksum(first.checkpoint, { lastRecordSha256: HASH });
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: records.messages[0],
      records: [records.messages[1]],
      complete: true,
    }, { priorCheckpoint: forgedPrior })), "checkpoint-mismatch");
  });

  it("sanitizes a throwing dependencies accessor at the public seam", () => {
    const manifest = makeManifest();
    const canary = "dependencies-accessor-canary-616";
    const record = { ...records.messages[0] };
    Object.defineProperty(record, "dependencies", {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error(canary);
      },
    });
    try {
      createPortableBatch(createBatchInput(manifest, "messages", {
        predecessor: null,
        records: [record],
        complete: false,
      }));
    } catch (error) {
      expectSanitizedError(error, "malformed-record", [canary]);
      return;
    }
    throw new Error("operation unexpectedly succeeded");
  });

  it("sanitizes a throwing ordinal accessor while constructing dependency errors", () => {
    const manifest = makeManifest();
    const canary = "ordinal-accessor-canary-616";
    const record = { ...records.messages[0], dependencies: [] };
    Object.defineProperty(record, "ordinal", {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error(canary);
      },
    });
    try {
      createPortableBatch(createBatchInput(manifest, "messages", {
        predecessor: null,
        records: [record],
        complete: false,
      }));
    } catch (error) {
      expectSanitizedError(error, "malformed-record", [canary]);
      return;
    }
    throw new Error("operation unexpectedly succeeded");
  });

  it("rejects dependency order, wrong dependency identity, appended records, and terminal omission", () => {
    const manifest = makeManifest();
    const wrongDependency = {
      ...records.messages[0],
      dependencies: [{ domain: "project", identitySha256: projectIdentitySha256 }],
    };
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: null,
      records: [wrongDependency],
      complete: false,
    })), "dependency-order");
    const omitted = makeManifest(makeSourceDescription(), { ...records, messages: [records.messages[0]] });
    expectCode(() => createPortableBatch(createBatchInput(omitted, "messages", {
      predecessor: null,
      records: [records.messages[0], records.messages[1]],
      complete: true,
    })), "partial-batch");
    const appended = makeRecord("messages", { ...representativeValues.messages, seq: 2, content: "appended" }, 2, { conversationOrder });
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: records.messages[1],
      records: [appended],
      complete: true,
    }, {
      priorCheckpoint: {
        version: 1,
        manifestSha256: manifest.manifestSha256,
        domain: "messages",
        nextOrdinal: 2,
        recordCount: 2,
        prefixSha256: manifest.domains.find((entry) => entry.domain === "messages")?.prefixSha256,
        lastRecordIdentitySha256: records.messages[1].identitySha256,
        lastRecordSha256: records.messages[1].recordSha256,
        previousCheckpointSha256: null,
        complete: true,
        checkpointSha256: HASH,
      },
    })), "checkpoint-mismatch");
  });

  it("serializes, parses, and structurally verifies initial and terminal checkpoints", () => {
    const manifest = makeManifest();
    const batch = asPortableBatch(createPortableBatch(createBatchInput(manifest, "redaction-counters", {
      predecessor: null,
      records: [records["redaction-counters"][0]],
      complete: true,
    })));
    const checkpoint = batch.checkpoint;
    expect(checkpoint).toMatchObject({
      version: 1,
      manifestSha256: manifest.manifestSha256,
      domain: "redaction-counters",
      recordCount: checkpoint.nextOrdinal,
      complete: true,
      previousCheckpointSha256: null,
    });
    expect(checkpoint.lastRecordIdentitySha256).toBe(records["redaction-counters"][0].identitySha256);
    expect(parsePortableCheckpoint(serializePortableCheckpoint(checkpoint))).toEqual(checkpoint);
    expect(verifyPortableCheckpoint(checkpoint, manifest as never)).toEqual(checkpoint);
    expectDeepFrozen(checkpoint);
  });

  it("rejects checkpoint serialization tampering and replay across manifests or domains", () => {
    const manifest = makeManifest();
    const batch = asPortableBatch(createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: null,
      records: [records.messages[0]],
      complete: false,
    })));
    const checkpoint = batch.checkpoint;
    const parsed = JSON.parse(Buffer.from(serializePortableCheckpoint(checkpoint)).toString("utf8")) as Record<string, unknown>;
    for (const [field, value] of [
      ["manifestSha256", HASH],
      ["domain", "project"],
      ["nextOrdinal", 99],
      ["recordCount", 98],
      ["prefixSha256", HASH],
      ["checkpointSha256", HASH],
    ] as const) {
      expectCode(() => parsePortableCheckpoint(Buffer.from(`${referenceCanonicalJson({ ...parsed, [field]: value })}\n`)), "checkpoint-mismatch");
    }
    expectCode(() => verifyPortableCheckpoint({ ...checkpoint, domain: "project" } as never, manifest as never), "checkpoint-mismatch");
    expectCode(() => verifyPortableCheckpoint(checkpoint, { ...manifest, manifestSha256: HASH } as never), "checkpoint-mismatch");
  });

  it("rejects malformed control framing, checkpoint nullability, and prefix bindings", () => {
    const manifest = makeManifest();
    const batch = asPortableBatch(createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: null,
      records: [records.messages[0]],
      complete: false,
    })));
    const checkpoint = batch.checkpoint;
    const serialized = serializePortableCheckpoint(checkpoint);
    expectCode(() => parsePortableCheckpoint("not-bytes" as never), "checkpoint-mismatch");
    expectCode(() => parsePortableCheckpoint(new Uint8Array()), "checkpoint-mismatch");
    expectCode(() => parsePortableCheckpoint(serialized.subarray(0, -1)), "checkpoint-mismatch");
    expectCode(() => parsePortableCheckpoint(Buffer.concat([Buffer.from(serialized), Buffer.from("\n")])), "checkpoint-mismatch");
    expectCode(() => parsePortableCheckpoint(Uint8Array.from([0xff, 0x0a])), "checkpoint-mismatch");
    expectCode(() => parsePortableCheckpoint(Buffer.from("{\n", "utf8")), "checkpoint-mismatch");
    expectCode(() => parsePortableCheckpoint(Buffer.from(` ${Buffer.from(serialized).toString("utf8")}`, "utf8")), "checkpoint-mismatch");
    const tooDeep = Buffer.from(`${"[".repeat(PORTABLE_LIMITS.maxJsonDepth + 1)}0${"]".repeat(PORTABLE_LIMITS.maxJsonDepth + 1)}\n`, "utf8");
    expectCode(() => parsePortableCheckpoint(tooDeep), "checkpoint-mismatch");

    const versionTampered = JSON.parse(Buffer.from(serialized).toString("utf8")) as Record<string, unknown>;
    versionTampered.version = 2;
    expectCode(() => parsePortableCheckpoint(Buffer.from(`${referenceCanonicalJson(versionTampered)}\n`)), "checkpoint-mismatch");
    expectCode(() => parsePortableCheckpoint(serializePortableCheckpoint(withCheckpointChecksum(checkpoint, {
      nextOrdinal: 0,
      recordCount: 0,
      lastRecordIdentitySha256: HASH,
    }))), "checkpoint-mismatch");
    expectCode(() => parsePortableCheckpoint(serializePortableCheckpoint(withCheckpointChecksum(checkpoint, {
      lastRecordIdentitySha256: null,
    }))), "checkpoint-mismatch");

    const otherManifest = makeManifest(makeSourceDescription({ sourceIdentitySha256: "3".repeat(64) }));
    expectCode(() => verifyPortableCheckpoint(checkpoint, otherManifest), "checkpoint-mismatch");
    const forgedInitial = withCheckpointChecksum(checkpoint, {
      nextOrdinal: 0,
      recordCount: 0,
      prefixSha256: HASH,
      lastRecordIdentitySha256: null,
      lastRecordSha256: null,
      previousCheckpointSha256: null,
      complete: false,
    });
    expectCode(() => verifyPortableCheckpoint(forgedInitial, manifest), "checkpoint-mismatch");
  });

  it("requires prior-checkpoint body equality only while creating a batch", () => {
    const manifest = makeManifest();
    const first = asPortableBatch(createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: null,
      records: [records.messages[0]],
      complete: false,
    })));
    const sameHashDifferentBody = {
      ...first.checkpoint,
      prefixSha256: HASH,
      checkpointSha256: first.checkpoint.checkpointSha256,
    };
    expectCode(() => createPortableBatch(createBatchInput(manifest, "messages", {
      predecessor: records.messages[0],
      records: [records.messages[1]],
      complete: true,
    }, { priorCheckpoint: sameHashDifferentBody })), "checkpoint-mismatch");
    expect(() => verifyPortableCheckpoint(first.checkpoint, manifest as never)).not.toThrow();
  });

  it("verifies only the current public boundary and leaves historical previous links destination-owned", async () => {
    const source = new FakePortableSource();
    const stream = await createPortableRecordStream(source);
    const batch = await stream.readBatch({ domain: "messages", maxRecords: 1, maxBytes: PORTABLE_LIMITS.maxBatchBytes });
    const forgedHistoricalLink = withCheckpointChecksum(batch.checkpoint, {
      previousCheckpointSha256: HASH,
    });
    const verification = await stream.verify(forgedHistoricalLink);
    expect(verification).toMatchObject({
      authoritative: true,
      checkpointSha256: forgedHistoricalLink.checkpointSha256,
      domain: "messages",
      nextOrdinal: forgedHistoricalLink.nextOrdinal,
      recordCount: forgedHistoricalLink.recordCount,
    });
    expect(source.verifyCalls.at(-1)?.boundary).toEqual(expect.objectContaining({
      domain: "messages",
      nextOrdinal: forgedHistoricalLink.nextOrdinal,
      recordCount: forgedHistoricalLink.recordCount,
      prefixSha256: forgedHistoricalLink.prefixSha256,
      lastRecordIdentitySha256: forgedHistoricalLink.lastRecordIdentitySha256,
      lastRecordSha256: forgedHistoricalLink.lastRecordSha256,
    }));
    await stream.close();
  });

  it("normalizes changed, invalid, unavailable, and thrown source outcomes to fixed errors", async () => {
    for (const [result, code] of [
      ["changed", "source-changed"],
      ["invalid", "source-invalid"],
      ["unavailable", "source-unavailable"],
    ] as const) {
      const source = new FakePortableSource();
      source.verifyResult = result;
      const streamPromise = createPortableRecordStream(source);
      await expectAsyncCode(() => streamPromise, code);
    }
    const unknownResult = new FakePortableSource();
    unknownResult.verifyResult = "unexpected" as never;
    await expectAsyncCode(() => createPortableRecordStream(unknownResult), "source-invalid");
    const thrown = new FakePortableSource();
    thrown.verifyFailure = new Error("source canary path=/secret/sql/password");
    try {
      await createPortableRecordStream(thrown);
      throw new Error("stream unexpectedly created");
    } catch (error) {
      expectSanitizedError(error, "source-unavailable", ["/secret/sql/password"]);
    }
  });

  it("serializes read and verify calls and passes exact source verification inputs", async () => {
    const source = new FakePortableSource();
    const stream = await createPortableRecordStream(source);
    const initial = await stream.readBatch({
      domain: "messages",
      maxRecords: 1,
      maxBytes: PORTABLE_LIMITS.maxBatchBytes,
    });
    let active = 0;
    let peak = 0;
    let pageCount = 0;
    const firstStarted = deferred();
    const secondStarted = deferred();
    const firstRelease = deferred();
    const secondRelease = deferred();
    source.pageFactory = async (input) => {
      const index = pageCount;
      pageCount += 1;
      active += 1;
      peak = Math.max(peak, active);
      (index === 0 ? firstStarted : secondStarted).resolve();
      await (index === 0 ? firstRelease : secondRelease).promise;
      active -= 1;
      return {
        predecessor: records[input.domain][input.afterOrdinal - 1] ?? null,
        records: [records[input.domain][input.afterOrdinal]],
        complete: true,
      };
    };
    const firstPromise = stream.readBatch({
      domain: "messages",
      after: initial.checkpoint,
      maxRecords: 1,
      maxBytes: PORTABLE_LIMITS.maxBatchBytes,
    });
    await firstStarted.promise;
    const secondPromise = stream.readBatch({
      domain: "messages",
      after: initial.checkpoint,
      maxRecords: 1,
      maxBytes: PORTABLE_LIMITS.maxBatchBytes,
    });
    const verificationPromise = stream.verify(initial.checkpoint);
    await Promise.resolve();
    expect(active).toBe(1);
    expect(pageCount).toBe(1);
    expect(source.verifyCalls.filter((input) => input.boundary !== undefined)).toHaveLength(0);
    firstRelease.resolve();
    await secondStarted.promise;
    expect(active).toBe(1);
    expect(pageCount).toBe(2);
    expect(source.verifyCalls.filter((input) => input.boundary !== undefined)).toHaveLength(0);
    secondRelease.resolve();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    const verification = await verificationPromise;
    expect(first.records).toEqual([records.messages[1]]);
    expect(second.records).toEqual([records.messages[1]]);
    expect(peak).toBe(1);
    expect(verification.authoritative).toBe(true);
    expect(source.verifyCalls.at(-1)).toMatchObject({
      sourceIdentitySha256: source.description.sourceIdentitySha256,
      sourceWitnessSha256: source.description.sourceWitnessSha256,
      manifestSha256: stream.describe().manifestSha256,
      boundary: {
        domain: "messages",
        nextOrdinal: initial.checkpoint.nextOrdinal,
        recordCount: initial.checkpoint.recordCount,
        prefixSha256: initial.checkpoint.prefixSha256,
        lastRecordIdentitySha256: initial.checkpoint.lastRecordIdentitySha256,
        lastRecordSha256: initial.checkpoint.lastRecordSha256,
      },
    });
    await stream.close();
  });

  it("rejects forged partial boundaries and preserves the unchanged prior checkpoint after failures", async () => {
    const source = new FakePortableSource();
    const stream = await createPortableRecordStream(source);
    const first = await stream.readBatch({ domain: "messages", maxRecords: 1, maxBytes: PORTABLE_LIMITS.maxBatchBytes });
    const forged = { ...first.checkpoint, prefixSha256: HASH };
    await expectAsyncCode(() => stream.verify(forged), "checkpoint-mismatch");
    await expectAsyncCode(() => stream.readBatch({
      domain: "project",
      after: first.checkpoint,
      maxRecords: 1,
      maxBytes: PORTABLE_LIMITS.maxBatchBytes,
    }), "checkpoint-mismatch");
    const retry = await stream.readBatch({ domain: "messages", after: first.checkpoint, maxRecords: 1, maxBytes: PORTABLE_LIMITS.maxBatchBytes });
    expect(retry.priorCheckpointSha256).toBe(first.checkpoint.checkpointSha256);
    expect(retry.checkpoint.previousCheckpointSha256).toBe(first.checkpoint.checkpointSha256);
    await stream.close();
  });

  it("supports prequeued and in-flight abort without advancing a checkpoint", async () => {
    const source = new FakePortableSource();
    const stream = await createPortableRecordStream(source);
    let release: (() => void) | undefined;
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    source.pageFactory = async (input) => {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return { predecessor: null, records: [records[input.domain][0]], complete: true };
    };
    const firstAbort = new AbortController();
    firstAbort.abort();
    await expectAsyncCode(() => stream.readBatch({ domain: "messages", maxRecords: 1, maxBytes: PORTABLE_LIMITS.maxBatchBytes, signal: firstAbort.signal }), "aborted");
    const inFlightAbort = new AbortController();
    const read = stream.readBatch({ domain: "messages", maxRecords: 1, maxBytes: PORTABLE_LIMITS.maxBatchBytes, signal: inFlightAbort.signal });
    await readStarted;
    inFlightAbort.abort();
    release?.();
    await expectAsyncCode(() => read, "aborted");
    await stream.close();
  });

  it("returns a rejected Promise instead of throwing synchronously for a pre-aborted read", async () => {
    const source = new FakePortableSource();
    const stream = await createPortableRecordStream(source);
    const controller = new AbortController();
    controller.abort();
    let result: Promise<PortableBatch> | undefined;

    expect(() => {
      result = stream.readBatch({
        domain: "messages",
        maxRecords: 1,
        maxBytes: PORTABLE_LIMITS.maxBatchBytes,
        signal: controller.signal,
      });
    }).not.toThrow();
    expect(result).toBeInstanceOf(Promise);
    await expectAsyncCode(() => result as Promise<PortableBatch>, "aborted");
    expect(source.pageCalls.filter((call) => call.domain === "messages")).toHaveLength(1);
    await stream.close();
  });

  it("closes atomically, waits for current work, rejects later calls, and closes the source once", async () => {
    const source = new FakePortableSource();
    const stream = await createPortableRecordStream(source);
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    source.pageFactory = async (input) => {
      readStarted();
      await new Promise<void>((resolve) => { releaseRead = resolve; });
      return { predecessor: null, records: [records[input.domain][0]], complete: true };
    };
    const read = stream.readBatch({ domain: "messages", maxRecords: 1, maxBytes: PORTABLE_LIMITS.maxBatchBytes });
    await started;
    const closeA = stream.close();
    const closeB = stream.close();
    await Promise.resolve();
    expect(source.close).not.toHaveBeenCalled();
    releaseRead();
    await read.catch(() => undefined);
    await Promise.all([closeA, closeB]);
    expect(source.close).toHaveBeenCalledTimes(1);
    await expectAsyncCode(() => stream.readBatch({ domain: "messages", maxRecords: 1, maxBytes: PORTABLE_LIMITS.maxBatchBytes }), "closed");
    await expectAsyncCode(() => stream.verify({} as never), "closed");
  });

  it("sanitizes a source close failure and settles repeated close calls once", async () => {
    const source = new FakePortableSource();
    const stream = await createPortableRecordStream(source);
    source.closeFailure = new Error("close canary /secret/storage password=task-2");
    const first = stream.close();
    const second = stream.close();
    for (const close of [first, second]) {
      try {
        await close;
        throw new Error("close unexpectedly succeeded");
      } catch (error) {
        expectSanitizedError(error, "source-unavailable", ["/secret/storage", "password=task-2"]);
      }
    }
    expect(source.close).toHaveBeenCalledTimes(1);
    await expectAsyncCode(() => stream.readBatch({ domain: "messages", maxRecords: 1, maxBytes: PORTABLE_LIMITS.maxBatchBytes }), "closed");
  });

  it("keeps public batches, checkpoints, manifests, and verifications deeply immutable", async () => {
    const source = new FakePortableSource();
    const stream = await createPortableRecordStream(source);
    const manifest = stream.describe();
    const batch = await stream.readBatch({ domain: "messages", maxRecords: 1, maxBytes: PORTABLE_LIMITS.maxBatchBytes });
    const verification = await stream.verify(batch.checkpoint);
    expectDeepFrozen(manifest);
    expectDeepFrozen(batch);
    expectDeepFrozen(batch.checkpoint);
    expectDeepFrozen(verification);
    expect(() => (batch.records as PortableRecord[]).push(records.messages[0])).toThrow();
    await stream.close();
  });

  it("serializes every Task 2 error as bounded cause-free JSON", () => {
    const task2Codes = [
      "malformed-manifest",
      "incompatible-schema",
      "invalid-limit",
      "batch-limit-exceeded",
      "checkpoint-mismatch",
      "partial-batch",
      "source-changed",
      "source-invalid",
      "source-unavailable",
      "aborted",
      "closed",
    ];
    for (const code of task2Codes) {
      const error = new PortableStreamError(code as never, {
        domain: "messages",
        ordinal: 7,
        recordCount: 8,
        manifestSha256: HASH,
        checkpointSha256: HASH,
        retryable: code === "batch-limit-exceeded" || code === "source-unavailable" || code === "aborted",
      });
      expectSanitizedError(error, code, ["/secret", "password", "adapter detail"]);
      expect(JSON.parse(JSON.stringify(error))).not.toHaveProperty("cause");
    }
  });

  it("keeps source paths, payloads, parser text, and adapter causes out of failures", async () => {
    const source = new FakePortableSource();
    const stream = await createPortableRecordStream(source);
    source.readFailure = new Error("adapter secret /home/user/.ssh/id_rsa SQL password=canary");
    try {
      await stream.readBatch({ domain: "messages", maxRecords: 1, maxBytes: PORTABLE_LIMITS.maxBatchBytes });
      throw new Error("read unexpectedly succeeded");
    } catch (error) {
      expectSanitizedError(error, "source-unavailable", ["/home/user/.ssh/id_rsa", "password=canary"]);
    }
    await stream.close();
  });
});
