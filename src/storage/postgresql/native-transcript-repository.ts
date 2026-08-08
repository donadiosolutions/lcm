import type { QueryResultRow } from "pg";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  NATIVE_TRANSCRIPT_MAX_JSON_DEPTH,
  type CreateNativeTranscriptInput,
  type CreateNativeTranscriptMessageLinkInput,
  type JsonObject,
  type JsonValue,
  type NativeTranscriptBatchInput,
  type NativeTranscriptBatchResult,
  type NativeTranscriptCheckpointKey,
  type NativeTranscriptCheckpointRecord,
  type NativeTranscriptMessageLinkRecord,
  type NativeTranscriptMessageSnapshotRepository,
  type NativeTranscriptRecord,
  type NativeTranscriptRepository,
  type NativeTranscriptSessionMessageRecord,
} from "../contracts.js";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlQueryExecutor,
  PostgreSqlTransactionOptions,
  PostgreSqlTransactionScopeExecutor,
} from "./contracts.js";
import { PostgreSqlCommitOutcomeUnknownError } from "./errors.js";

const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_INT4 = 2_147_483_647;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:[a-zA-Z]:|[\\/])/u;

const TRANSCRIPT_COLUMNS = `
  transcript.transcript_id,
  transcript.project_id,
  transcript.machine_id,
  transcript.client_name,
  transcript.format_name,
  transcript.format_version,
  transcript.native_session_id,
  transcript.source_locator,
  transcript.source_ordinal,
  transcript.observed_at,
  transcript.ingested_at,
  transcript.scrubber_version,
  transcript.content_sha256,
  transcript.ingest_key,
  transcript.native_payload,
  COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'transcript_id', link.transcript_id,
        'conversation_id', link.conversation_id,
        'message_id', link.message_id,
        'source_ordinal', link.source_ordinal
      )
      ORDER BY link.source_ordinal,
               link.message_id,
               link.conversation_id
    ) FILTER (WHERE link.transcript_id IS NOT NULL),
    '[]'::pg_catalog.jsonb
  ) AS message_links
`.trim();

const TRANSCRIPT_LINK_JOIN = `
  LEFT JOIN lcm.transcript_messages AS link
    ON link.project_id = transcript.project_id
   AND link.transcript_id = transcript.transcript_id
`.trim();

type PostgreSqlNativeTranscriptContext = PostgreSqlTransactionOptions & {
  readonly domain: "native-transcripts";
  readonly projectId: string;
};

export interface PostgreSqlNativeTranscriptExecutor
  extends PostgreSqlQueryExecutor {
  transaction<T>(
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlNativeTranscriptContext,
  ): Promise<T>;
}

export interface PostgreSqlNativeTranscriptScopedExecutor
  extends PostgreSqlTransactionScopeExecutor {}

type RepositoryExecutor =
  | PostgreSqlNativeTranscriptExecutor
  | PostgreSqlNativeTranscriptScopedExecutor;

type ScopedExecutorState = { tail: Promise<void> };
const scopedExecutorStates = new WeakMap<
  PostgreSqlNativeTranscriptScopedExecutor,
  ScopedExecutorState
>();

type TranscriptRow = QueryResultRow & {
  transcript_id: unknown;
  project_id: unknown;
  machine_id: unknown;
  client_name: unknown;
  format_name: unknown;
  format_version: unknown;
  native_session_id: unknown;
  source_locator: unknown;
  source_ordinal: unknown;
  observed_at: unknown;
  ingested_at: unknown;
  scrubber_version: unknown;
  content_sha256: unknown;
  ingest_key: unknown;
  native_payload: unknown;
  message_links: unknown;
};

type TranscriptMatchRow = TranscriptRow & { exact_match: unknown };

type CheckpointRow = QueryResultRow & {
  project_id: unknown;
  machine_id: unknown;
  client_name: unknown;
  source_locator: unknown;
  revision: unknown;
  last_source_ordinal: unknown;
  imported_count: unknown;
  skipped_count: unknown;
  quarantined_count: unknown;
  checkpoint: unknown;
  updated_at: unknown;
};

type LinkRow = QueryResultRow & {
  transcript_id: unknown;
  conversation_id: unknown;
  message_id: unknown;
  source_ordinal: unknown;
};

type SessionMessageRow = QueryResultRow & {
  conversation_id: unknown;
  message_id: unknown;
  message_sequence: unknown;
  role: unknown;
  content: unknown;
};

type TransactionIsolationRow = QueryResultRow & {
  transaction_isolation: unknown;
};

export class PostgreSqlNativeTranscriptDataError extends StorageOperationError {
  constructor(
    projectId: string,
    operation: string,
    readonly field: string,
  ) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      projectId,
      "native-transcripts",
      operation,
    );
    this.name = "PostgreSqlNativeTranscriptDataError";
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), field: this.field };
  }
}

export class PostgreSqlNativeTranscriptConflictError
  extends StorageOperationError {
  constructor(
    projectId: string,
    operation: string,
    readonly ingestKey: string,
  ) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      projectId,
      "native-transcripts",
      operation,
    );
    this.name = "PostgreSqlNativeTranscriptConflictError";
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), ingestKey: this.ingestKey };
  }
}

export class PostgreSqlNativeTranscriptCheckpointConflictError
  extends StorageOperationError {
  constructor(projectId: string, operation: string) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      projectId,
      "native-transcripts",
      operation,
    );
    this.name = "PostgreSqlNativeTranscriptCheckpointConflictError";
  }
}

function safeInteger(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
): number {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return value;
    throw new PostgreSqlNativeTranscriptDataError(projectId, operation, field);
  }
  if (
    typeof value !== "bigint"
    && (typeof value !== "string" || !/^-?\d+$/u.test(value))
  ) {
    throw new PostgreSqlNativeTranscriptDataError(projectId, operation, field);
  }
  const candidate = typeof value === "bigint" ? value : BigInt(value);
  if (candidate < MIN_SAFE_BIGINT || candidate > MAX_SAFE_BIGINT) {
    throw new PostgreSqlNativeTranscriptDataError(projectId, operation, field);
  }
  return Number(candidate);
}

function nonnegativeInteger(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
): number {
  const candidate = safeInteger(value, projectId, operation, field);
  if (candidate < 0) {
    throw new PostgreSqlNativeTranscriptDataError(projectId, operation, field);
  }
  return candidate;
}

function string(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new PostgreSqlNativeTranscriptDataError(projectId, operation, field);
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new PostgreSqlNativeTranscriptDataError(
          projectId,
          operation,
          field,
        );
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new PostgreSqlNativeTranscriptDataError(
        projectId,
        operation,
        field,
      );
    }
  }
  return value;
}

function dataObject(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
): Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new PostgreSqlNativeTranscriptDataError(
      projectId,
      operation,
      field,
    );
  }
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new PostgreSqlNativeTranscriptDataError(
        projectId,
        operation,
        field,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new PostgreSqlNativeTranscriptDataError(
        projectId,
        operation,
        field,
      );
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  return result;
}

function dataArray(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new PostgreSqlNativeTranscriptDataError(
      projectId,
      operation,
      field,
    );
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1
    || keys.some((key) =>
      typeof key !== "string"
      || (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key)))
  ) {
    throw new PostgreSqlNativeTranscriptDataError(
      projectId,
      operation,
      field,
    );
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      String(index),
    );
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new PostgreSqlNativeTranscriptDataError(
        projectId,
        operation,
        field,
      );
    }
    result.push(descriptor.value);
  }
  return result;
}

function nonemptyString(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
  trim = false,
): string {
  const candidate = string(value, projectId, operation, field);
  if ((trim ? candidate.trim() : candidate).length === 0) {
    throw new PostgreSqlNativeTranscriptDataError(projectId, operation, field);
  }
  return candidate;
}

function relativeSourceLocator(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
): string {
  const candidate = nonemptyString(
    value,
    projectId,
    operation,
    field,
  );
  if (
    isAbsolute(candidate)
    || WINDOWS_ABSOLUTE_PATH_PATTERN.test(candidate)
    || candidate.split(/[\\/]/u).includes("..")
  ) {
    throw new PostgreSqlNativeTranscriptDataError(
      projectId,
      operation,
      field,
    );
  }
  return candidate;
}

function uuid(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
): string {
  const candidate = string(value, projectId, operation, field);
  if (!UUIDV7_PATTERN.test(candidate)) {
    throw new PostgreSqlNativeTranscriptDataError(projectId, operation, field);
  }
  return candidate.toLowerCase();
}

function digest(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
): string {
  const candidate = string(value, projectId, operation, field);
  if (!SHA256_PATTERN.test(candidate)) {
    throw new PostgreSqlNativeTranscriptDataError(projectId, operation, field);
  }
  return candidate;
}

function date(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
): Date {
  const candidate = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === "string"
      ? new Date(value)
      : new Date(Number.NaN);
  if (!Number.isFinite(candidate.getTime())) {
    throw new PostgreSqlNativeTranscriptDataError(projectId, operation, field);
  }
  return candidate;
}

function jsonValue(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
  seen = new Set<object>(),
  depth = 1,
): JsonValue {
  if (
    value === null
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value)
      || Object.is(value, -0)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new PostgreSqlNativeTranscriptDataError(
        projectId,
        operation,
        field,
      );
    }
    return value;
  }
  if (typeof value === "string") {
    return string(value, projectId, operation, field);
  }
  if (typeof value !== "object") {
    throw new PostgreSqlNativeTranscriptDataError(projectId, operation, field);
  }
  if (depth > NATIVE_TRANSCRIPT_MAX_JSON_DEPTH) {
    throw new PostgreSqlNativeTranscriptDataError(projectId, operation, field);
  }
  if (seen.has(value)) {
    throw new PostgreSqlNativeTranscriptDataError(projectId, operation, field);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(dataArray(
        value,
        projectId,
        operation,
        field,
      ).map((element) =>
        jsonValue(
          element,
          projectId,
          operation,
          field,
          seen,
          depth + 1,
        ))) as unknown as JsonValue[];
    }
    const normalized: Record<string, JsonValue> = {};
    const entries = Object.entries(dataObject(
      value,
      projectId,
      operation,
      field,
    )).sort(([left], [right]) =>
      left < right ? -1 : 1);
    for (const [key, element] of entries) {
      string(key, projectId, operation, field);
      Object.defineProperty(normalized, key, {
        configurable: true,
        enumerable: true,
        value: jsonValue(
          element,
          projectId,
          operation,
          field,
          seen,
          depth + 1,
        ),
        writable: true,
      });
    }
    return Object.freeze(normalized);
  } finally {
    seen.delete(value);
  }
}

function jsonObject(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
): JsonObject {
  const candidate = jsonValue(value, projectId, operation, field);
  if (candidate === null || Array.isArray(candidate) || typeof candidate !== "object") {
    throw new PostgreSqlNativeTranscriptDataError(projectId, operation, field);
  }
  return candidate;
}

function nativePayload(
  value: unknown,
  projectId: string,
  operation: string,
): JsonObject | JsonValue[] {
  const candidate = jsonValue(
    value,
    projectId,
    operation,
    "native_payload",
  );
  if (candidate === null || typeof candidate !== "object") {
    throw new PostgreSqlNativeTranscriptDataError(
      projectId,
      operation,
      "native_payload",
    );
  }
  return candidate;
}

function canonicalNativeTranscriptJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalNativeTranscriptJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) =>
      `${JSON.stringify(key)}:${canonicalNativeTranscriptJson(value[key])}`)
    .join(",")}}`;
}

function boolean(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
): boolean {
  if (typeof value !== "boolean") {
    throw new PostgreSqlNativeTranscriptDataError(projectId, operation, field);
  }
  return value;
}

function messageRole(
  value: unknown,
  projectId: string,
  operation: string,
): NativeTranscriptSessionMessageRecord["role"] {
  if (
    value !== "system"
    && value !== "user"
    && value !== "assistant"
    && value !== "tool"
  ) {
    throw new PostgreSqlNativeTranscriptDataError(
      projectId,
      operation,
      "role",
    );
  }
  return value;
}

function linkFromRow(
  row: LinkRow,
  projectId: string,
  operation: string,
): NativeTranscriptMessageLinkRecord {
  return {
    transcriptId: uuid(
      row.transcript_id,
      projectId,
      operation,
      "transcript_id",
    ),
    conversationId: nonnegativeInteger(
      row.conversation_id,
      projectId,
      operation,
      "conversation_id",
    ),
    messageId: nonnegativeInteger(
      row.message_id,
      projectId,
      operation,
      "message_id",
    ),
    sourceOrdinal: nonnegativeInteger(
      row.source_ordinal,
      projectId,
      operation,
      "link_source_ordinal",
    ),
  };
}

function linksFromJson(
  value: unknown,
  projectId: string,
  operation: string,
): NativeTranscriptMessageLinkRecord[] {
  if (!Array.isArray(value)) {
    throw new PostgreSqlNativeTranscriptDataError(
      projectId,
      operation,
      "message_links",
    );
  }
  return value.map((candidate) => {
    if (
      candidate === null
      || typeof candidate !== "object"
      || Array.isArray(candidate)
    ) {
      throw new PostgreSqlNativeTranscriptDataError(
        projectId,
        operation,
        "message_links",
      );
    }
    const row = candidate as Record<string, unknown>;
    return linkFromRow({
      transcript_id: row.transcript_id,
      conversation_id: row.conversation_id,
      message_id: row.message_id,
      source_ordinal: row.source_ordinal,
    }, projectId, operation);
  });
}

function transcriptFromRow(
  row: TranscriptRow,
  projectId: string,
  operation: string,
): NativeTranscriptRecord {
  const rowProjectId = uuid(
    row.project_id,
    projectId,
    operation,
    "project_id",
  );
  if (rowProjectId !== projectId) {
    throw new PostgreSqlNativeTranscriptDataError(
      projectId,
      operation,
      "project_id",
    );
  }
  return {
    transcriptId: uuid(
      row.transcript_id,
      projectId,
      operation,
      "transcript_id",
    ),
    projectId: rowProjectId,
    machineId: uuid(row.machine_id, projectId, operation, "machine_id"),
    clientName: nonemptyString(
      row.client_name,
      projectId,
      operation,
      "client_name",
      true,
    ),
    formatName: nonemptyString(
      row.format_name,
      projectId,
      operation,
      "format_name",
      true,
    ),
    formatVersion: nonemptyString(
      row.format_version,
      projectId,
      operation,
      "format_version",
      true,
    ),
    nativeSessionId: nonemptyString(
      row.native_session_id,
      projectId,
      operation,
      "native_session_id",
      true,
    ),
    sourceLocator: nonemptyString(
      row.source_locator,
      projectId,
      operation,
      "source_locator",
    ),
    sourceOrdinal: nonnegativeInteger(
      row.source_ordinal,
      projectId,
      operation,
      "source_ordinal",
    ),
    observedAt: date(row.observed_at, projectId, operation, "observed_at"),
    ingestedAt: date(row.ingested_at, projectId, operation, "ingested_at"),
    scrubberVersion: nonemptyString(
      row.scrubber_version,
      projectId,
      operation,
      "scrubber_version",
      true,
    ),
    contentSha256: digest(
      row.content_sha256,
      projectId,
      operation,
      "content_sha256",
    ),
    ingestKey: digest(row.ingest_key, projectId, operation, "ingest_key"),
    nativePayload: nativePayload(row.native_payload, projectId, operation),
    messageLinks: linksFromJson(
      row.message_links,
      projectId,
      operation,
    ),
  };
}

function checkpointFromRow(
  row: CheckpointRow,
  projectId: string,
  operation: string,
): NativeTranscriptCheckpointRecord {
  const rowProjectId = uuid(
    row.project_id,
    projectId,
    operation,
    "project_id",
  );
  if (rowProjectId !== projectId) {
    throw new PostgreSqlNativeTranscriptDataError(
      projectId,
      operation,
      "project_id",
    );
  }
  return {
    projectId: rowProjectId,
    machineId: uuid(row.machine_id, projectId, operation, "machine_id"),
    clientName: nonemptyString(
      row.client_name,
      projectId,
      operation,
      "client_name",
      true,
    ),
    sourceLocator: nonemptyString(
      row.source_locator,
      projectId,
      operation,
      "source_locator",
    ),
    revision: nonnegativeInteger(
      row.revision,
      projectId,
      operation,
      "revision",
    ),
    lastSourceOrdinal: nonnegativeInteger(
      row.last_source_ordinal,
      projectId,
      operation,
      "last_source_ordinal",
    ),
    importedCount: nonnegativeInteger(
      row.imported_count,
      projectId,
      operation,
      "imported_count",
    ),
    skippedCount: nonnegativeInteger(
      row.skipped_count,
      projectId,
      operation,
      "skipped_count",
    ),
    quarantinedCount: nonnegativeInteger(
      row.quarantined_count,
      projectId,
      operation,
      "quarantined_count",
    ),
    checkpoint: jsonObject(
      row.checkpoint,
      projectId,
      operation,
      "checkpoint",
    ),
    updatedAt: date(row.updated_at, projectId, operation, "updated_at"),
  };
}

function normalizedLinks(
  links: readonly CreateNativeTranscriptMessageLinkInput[] | undefined,
): readonly CreateNativeTranscriptMessageLinkInput[] {
  return [...(links ?? [])].sort((left, right) =>
    left.sourceOrdinal - right.sourceOrdinal);
}

function exactLinks(
  actual: readonly NativeTranscriptMessageLinkRecord[],
  expected: readonly CreateNativeTranscriptMessageLinkInput[] | undefined,
): boolean {
  const normalizedExpected = normalizedLinks(expected);
  if (actual.length !== normalizedExpected.length) return false;
  return actual.every((link, index) => {
    const candidate = normalizedExpected[index]!;
    return link.conversationId === candidate.conversationId
      && link.messageId === candidate.messageId
      && link.sourceOrdinal === candidate.sourceOrdinal;
  });
}

function sameJson(left: JsonObject, right: JsonObject): boolean {
  return isDeepStrictEqual(left, right);
}

function sameCheckpoint(
  actual: NativeTranscriptCheckpointRecord,
  expected: NativeTranscriptCheckpointRecord,
): boolean {
  return actual.projectId === expected.projectId
    && actual.machineId === expected.machineId
    && actual.clientName === expected.clientName
    && actual.sourceLocator === expected.sourceLocator
    && actual.revision === expected.revision
    && actual.lastSourceOrdinal === expected.lastSourceOrdinal
    && actual.importedCount === expected.importedCount
    && actual.skippedCount === expected.skippedCount
    && actual.quarantinedCount === expected.quarantinedCount
    && sameJson(actual.checkpoint, expected.checkpoint);
}

function sameCheckpointTarget(
  actual: NativeTranscriptCheckpointRecord,
  target: NativeTranscriptBatchInput["checkpoint"],
): boolean {
  return actual.lastSourceOrdinal === target.lastSourceOrdinal
    && sameJson(actual.checkpoint, target.checkpoint);
}

function reconcilesCommittedCheckpoint(
  actual: NativeTranscriptCheckpointRecord,
  candidate: NativeTranscriptCheckpointRecord,
): boolean {
  return actual.projectId === candidate.projectId
    && actual.machineId === candidate.machineId
    && actual.clientName === candidate.clientName
    && actual.sourceLocator === candidate.sourceLocator
    && actual.revision >= candidate.revision
    && actual.lastSourceOrdinal === candidate.lastSourceOrdinal
    && sameJson(actual.checkpoint, candidate.checkpoint)
    && actual.importedCount >= candidate.importedCount
    && actual.skippedCount >= candidate.skippedCount
    && actual.quarantinedCount >= candidate.quarantinedCount;
}

type CheckpointLockDisposition =
  | { readonly kind: "advance" }
  | {
      readonly kind: "matching-retry";
      readonly checkpoint: NativeTranscriptCheckpointRecord;
    };

export class PostgreSqlNativeTranscriptRepository
implements
  NativeTranscriptMessageSnapshotRepository,
  NativeTranscriptRepository {
  private readonly projectId: string;

  constructor(
    private readonly executor: RepositoryExecutor,
    projectId: string,
  ) {
    this.projectId = uuid(
      projectId,
      projectId,
      "construct",
      "project_id",
    );
  }

  async ingestBatch(
    input: NativeTranscriptBatchInput,
  ): Promise<NativeTranscriptBatchResult> {
    const operation = "ingestBatch";
    const batch = this.validateBatch(input, operation);
    let candidate: NativeTranscriptBatchResult | undefined;
    try {
      return await this.atomic(operation, async (transaction) => {
        const disposition = await this.lockCheckpoint(
          transaction,
          batch,
          operation,
        );
        let importedCount = 0;
        let skippedCount = 0;
        for (const record of batch.records) {
          if (disposition.kind === "matching-retry") {
            await this.assertExactTranscript(
              transaction,
              batch,
              record,
              operation,
            );
            skippedCount += 1;
            continue;
          }
          const inserted = await this.insertTranscript(
            transaction,
            batch,
            record,
            operation,
          );
          if (inserted === null) {
            skippedCount += 1;
            continue;
          }
          importedCount += 1;
          await this.insertLinks(
            transaction,
            inserted.transcriptId,
            record.messageLinks,
            operation,
          );
        }
        if (disposition.kind === "matching-retry") {
          candidate = {
            importedCount,
            skippedCount,
            quarantinedCount: batch.quarantinedCount,
            checkpoint: disposition.checkpoint,
          };
          return candidate;
        }
        const checkpoint = await this.advanceCheckpoint(
          transaction,
          batch,
          importedCount,
          skippedCount,
          operation,
        );
        candidate = {
          importedCount,
          skippedCount,
          quarantinedCount: batch.quarantinedCount,
          checkpoint,
        };
        return candidate;
      });
    } catch (error) {
      if (error instanceof PostgreSqlCommitOutcomeUnknownError && candidate) {
        const reconciled = await this.getCheckpoint(batch).catch(() => null);
        if (
          reconciled
          && reconcilesCommittedCheckpoint(reconciled, candidate.checkpoint)
        ) {
          const exactRecords = await this.verifyExactRecords(
            batch,
            operation,
          ).then(
            () => true,
            () => false,
          );
          if (exactRecords) {
            return { ...candidate, checkpoint: reconciled };
          }
        }
      }
      throw error;
    }
  }

  async getById(transcriptId: string): Promise<NativeTranscriptRecord | null> {
    const operation = "getById";
    const canonicalTranscriptId = uuid(
      transcriptId,
      this.projectId,
      operation,
      "transcript_id",
    );
    const rows = await this.readTranscripts(operation, {
      text: `SELECT ${TRANSCRIPT_COLUMNS}
             FROM lcm.native_transcripts AS transcript
             ${TRANSCRIPT_LINK_JOIN}
             WHERE transcript.project_id = $1
               AND transcript.transcript_id = $2
             GROUP BY transcript.transcript_id`,
      values: [this.projectId, canonicalTranscriptId],
    });
    return rows[0] ?? null;
  }

  async listByNativeSession(input: {
    readonly nativeSessionId: string;
  }): Promise<NativeTranscriptRecord[]> {
    const operation = "listByNativeSession";
    const nativeSessionId = nonemptyString(
      input.nativeSessionId,
      this.projectId,
      operation,
      "native_session_id",
      true,
    );
    return this.readTranscripts(operation, {
      text: `SELECT ${TRANSCRIPT_COLUMNS}
             FROM lcm.native_transcripts AS transcript
             ${TRANSCRIPT_LINK_JOIN}
             WHERE transcript.project_id = $1
               AND transcript.native_session_id_sha256 =
                   public.digest($2, 'sha256')
               AND transcript.native_session_id = $2
             GROUP BY transcript.transcript_id
             ORDER BY transcript.observed_at, transcript.transcript_id`,
      values: [this.projectId, nativeSessionId],
    });
  }

  async listBySource(
    input: NativeTranscriptCheckpointKey,
  ): Promise<NativeTranscriptRecord[]> {
    const operation = "listBySource";
    const key = this.validateKey(input, operation);
    return this.readTranscripts(operation, {
      text: `SELECT ${TRANSCRIPT_COLUMNS}
             FROM lcm.native_transcripts AS transcript
             ${TRANSCRIPT_LINK_JOIN}
             WHERE transcript.project_id = $1
               AND transcript.machine_id = $2
               AND transcript.client_name = $3
               AND transcript.source_locator = $4
             GROUP BY transcript.transcript_id
             ORDER BY transcript.source_ordinal, transcript.transcript_id`,
      values: [
        this.projectId,
        key.machineId,
        key.clientName,
        key.sourceLocator,
      ],
    });
  }

  async listByMessage(input: {
    readonly conversationId: number;
    readonly messageId: number;
  }): Promise<NativeTranscriptRecord[]> {
    const operation = "listByMessage";
    const conversationId = nonnegativeInteger(
      input.conversationId,
      this.projectId,
      operation,
      "conversation_id",
    );
    const messageId = nonnegativeInteger(
      input.messageId,
      this.projectId,
      operation,
      "message_id",
    );
    return this.readTranscripts(operation, {
      text: `SELECT ${TRANSCRIPT_COLUMNS}
             FROM lcm.native_transcripts AS transcript
             INNER JOIN lcm.transcript_messages AS selected_link
               ON selected_link.project_id = transcript.project_id
              AND selected_link.transcript_id = transcript.transcript_id
             ${TRANSCRIPT_LINK_JOIN}
             WHERE transcript.project_id = $1
               AND selected_link.conversation_id = $2
               AND selected_link.message_id = $3
             GROUP BY transcript.transcript_id, selected_link.source_ordinal
             ORDER BY selected_link.source_ordinal, transcript.transcript_id`,
      values: [this.projectId, conversationId, messageId],
    });
  }

  async getCheckpoint(
    input: NativeTranscriptCheckpointKey,
  ): Promise<NativeTranscriptCheckpointRecord | null> {
    const operation = "getCheckpoint";
    const key = this.validateKey(input, operation);
    return this.read(operation, async (executor) => {
      const result = await executor.query<CheckpointRow>({
        text: `SELECT project_id, machine_id, client_name, source_locator,
                      revision,
                      last_source_ordinal, imported_count, skipped_count,
                      quarantined_count, checkpoint, updated_at
               FROM lcm.ingest_checkpoints
               WHERE project_id = $1
                 AND machine_id = $2
                 AND client_name = $3
                 AND source_locator = $4`,
        values: [
          this.projectId,
          key.machineId,
          key.clientName,
          key.sourceLocator,
        ],
      }, this.context(operation));
      const row = result.rows[0];
      return row ? checkpointFromRow(row, this.projectId, operation) : null;
    });
  }

  async getNativeTranscriptMessageSnapshot(
    nativeSessionId: string,
  ): Promise<readonly NativeTranscriptSessionMessageRecord[]> {
    const operation = "getNativeTranscriptMessageSnapshot";
    nonemptyString(
      nativeSessionId,
      this.projectId,
      operation,
      "native_session_id",
      true,
    );
    return this.read(operation, async (executor) => {
      const result = await executor.query<SessionMessageRow>({
        text: `SELECT conversation.conversation_id,
                      message.message_id,
                      message.seq AS message_sequence,
                      message.role,
                      message.content
               FROM lcm.conversations AS conversation
               INNER JOIN lcm.messages AS message
                 ON message.project_id = conversation.project_id
                AND message.conversation_id = conversation.conversation_id
               WHERE conversation.project_id = $1
                 AND conversation.session_id_sha256 =
                   public.digest($2, 'sha256')
                 AND conversation.session_id = $2
               ORDER BY conversation.created_at,
                        conversation.conversation_id,
                        message.seq,
                        message.message_id`,
        values: [this.projectId, nativeSessionId],
      }, this.context(operation));
      return result.rows.map((row) => ({
        conversationId: nonnegativeInteger(
          row.conversation_id,
          this.projectId,
          operation,
          "conversation_id",
        ),
        messageId: nonnegativeInteger(
          row.message_id,
          this.projectId,
          operation,
          "message_id",
        ),
        messageSequence: nonnegativeInteger(
          row.message_sequence,
          this.projectId,
          operation,
          "message_sequence",
        ),
        role: messageRole(row.role, this.projectId, operation),
        content: string(
          row.content,
          this.projectId,
          operation,
          "content",
        ),
      }));
    });
  }

  private async readTranscripts(
    operation: string,
    config: { readonly text: string; readonly values: unknown[] },
  ): Promise<NativeTranscriptRecord[]> {
    return this.read(operation, async (executor) => {
      const result = await executor.query<TranscriptRow>(
        config,
        this.context(operation),
      );
      return result.rows.map((row) =>
        transcriptFromRow(row, this.projectId, operation));
    });
  }

  private async lockCheckpoint(
    executor: PostgreSqlQueryExecutor,
    input: NativeTranscriptBatchInput,
    operation: string,
  ): Promise<CheckpointLockDisposition> {
    const inserted = await executor.query<CheckpointRow>({
      text: `INSERT INTO lcm.ingest_checkpoints (
               project_id, machine_id, client_name, source_locator
             )
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (project_id, machine_id, client_name, source_locator)
             DO NOTHING
             RETURNING project_id, machine_id, client_name, source_locator,
                       revision, last_source_ordinal, imported_count,
                       skipped_count,
                       quarantined_count, checkpoint, updated_at`,
      values: [
        this.projectId,
        input.machineId,
        input.clientName,
        input.sourceLocator,
      ],
    }, this.context(operation));
    const created = inserted.rows[0];
    if (created) {
      if (input.expectedCheckpoint !== null) {
        throw new PostgreSqlNativeTranscriptCheckpointConflictError(
          this.projectId,
          operation,
        );
      }
      return { kind: "advance" };
    }
    const locked = await executor.query<CheckpointRow>({
      text: `SELECT project_id, machine_id, client_name, source_locator,
                    revision,
                    last_source_ordinal, imported_count, skipped_count,
                    quarantined_count, checkpoint, updated_at
             FROM lcm.ingest_checkpoints
             WHERE project_id = $1
               AND machine_id = $2
               AND client_name = $3
               AND source_locator = $4
             FOR UPDATE`,
      values: [
        this.projectId,
        input.machineId,
        input.clientName,
        input.sourceLocator,
      ],
    }, this.context(operation));
    const row = locked.rows[0];
    if (!row) {
      throw new PostgreSqlNativeTranscriptDataError(
        this.projectId,
        operation,
        "checkpoint",
      );
    }
    const actual = checkpointFromRow(row, this.projectId, operation);
    if (sameCheckpointTarget(actual, input.checkpoint)) {
      return { kind: "matching-retry", checkpoint: actual };
    }
    if (
      input.expectedCheckpoint !== null
      && sameCheckpoint(actual, input.expectedCheckpoint)
    ) {
      return { kind: "advance" };
    }
    throw new PostgreSqlNativeTranscriptCheckpointConflictError(
      this.projectId,
      operation,
    );
  }

  private async insertTranscript(
    executor: PostgreSqlQueryExecutor,
    batch: NativeTranscriptBatchInput,
    input: CreateNativeTranscriptInput,
    operation: string,
  ): Promise<NativeTranscriptRecord | null> {
    const payload = JSON.stringify(input.nativePayload);
    const inserted = await executor.query<TranscriptRow>({
      text: `INSERT INTO lcm.native_transcripts (
               project_id, machine_id, client_name, format_name,
               format_version, native_session_id, source_locator,
               source_ordinal, observed_at, ingested_at, scrubber_version,
               content_sha256, ingest_key, native_payload
             )
             VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11,
               $12, $13::pg_catalog.jsonb
             )
             ON CONFLICT (project_id, machine_id, ingest_key) DO NOTHING
             RETURNING transcript_id, project_id, machine_id, client_name,
                       format_name, format_version, native_session_id,
                       source_locator, source_ordinal, observed_at, ingested_at,
                       scrubber_version, content_sha256, ingest_key,
                       native_payload, '[]'::pg_catalog.jsonb AS message_links`,
      values: [
        this.projectId,
        batch.machineId,
        batch.clientName,
        input.formatName,
        input.formatVersion,
        input.nativeSessionId,
        batch.sourceLocator,
        input.sourceOrdinal,
        input.observedAt,
        input.scrubberVersion,
        input.contentSha256,
        input.ingestKey,
        payload,
      ],
    }, this.context(operation));
    const insertedRow = inserted.rows[0];
    if (insertedRow) {
      return transcriptFromRow(insertedRow, this.projectId, operation);
    }

    await this.assertExactTranscript(executor, batch, input, operation, payload);
    return null;
  }

  private async assertExactTranscript(
    executor: PostgreSqlQueryExecutor,
    batch: NativeTranscriptBatchInput,
    input: CreateNativeTranscriptInput,
    operation: string,
    serializedPayload = JSON.stringify(input.nativePayload),
  ): Promise<void> {
    const existing = await executor.query<TranscriptMatchRow>({
      text: `SELECT ${TRANSCRIPT_COLUMNS},
                    (
                      transcript.client_name = $3
                      AND transcript.format_name = $4
                      AND transcript.format_version = $5
                      AND transcript.native_session_id = $6
                      AND transcript.source_locator = $7
                      AND transcript.source_ordinal = $8
                      AND transcript.content_sha256 = $9
                      AND transcript.native_payload = $11::pg_catalog.jsonb
                    ) AS exact_match
             FROM lcm.native_transcripts AS transcript
             ${TRANSCRIPT_LINK_JOIN}
             WHERE transcript.project_id = $1
               AND transcript.machine_id = $2
               AND transcript.ingest_key = $10
             GROUP BY transcript.transcript_id`,
      values: [
        this.projectId,
        batch.machineId,
        batch.clientName,
        input.formatName,
        input.formatVersion,
        input.nativeSessionId,
        batch.sourceLocator,
        input.sourceOrdinal,
        input.contentSha256,
        input.ingestKey,
        serializedPayload,
      ],
    }, this.context(operation));
    const row = existing.rows[0];
    if (!row || !boolean(
      row.exact_match,
      this.projectId,
      operation,
      "exact_match",
    )) {
      throw new PostgreSqlNativeTranscriptConflictError(
        this.projectId,
        operation,
        input.ingestKey,
      );
    }
    const record = transcriptFromRow(row, this.projectId, operation);
    if (!exactLinks(record.messageLinks, input.messageLinks)) {
      throw new PostgreSqlNativeTranscriptConflictError(
        this.projectId,
        operation,
        input.ingestKey,
      );
    }
  }

  private async verifyExactRecords(
    input: NativeTranscriptBatchInput,
    operation: string,
  ): Promise<void> {
    await this.read(operation, async (executor) => {
      for (const record of input.records) {
        await this.assertExactTranscript(
          executor,
          input,
          record,
          operation,
        );
      }
    });
  }

  private async insertLinks(
    executor: PostgreSqlQueryExecutor,
    transcriptId: string,
    links: readonly CreateNativeTranscriptMessageLinkInput[] | undefined,
    operation: string,
  ): Promise<void> {
    for (const link of normalizedLinks(links)) {
      const result = await executor.query<LinkRow>({
        text: `INSERT INTO lcm.transcript_messages (
                 project_id, transcript_id, conversation_id, message_id,
                 source_ordinal
               )
               VALUES ($1, $2, $3, $4, $5)
               RETURNING transcript_id, conversation_id, message_id,
                         source_ordinal`,
        values: [
          this.projectId,
          transcriptId,
          link.conversationId,
          link.messageId,
          link.sourceOrdinal,
        ],
      }, this.context(operation));
      if (!result.rows[0]) {
        throw new PostgreSqlNativeTranscriptDataError(
          this.projectId,
          operation,
          "message_link",
        );
      }
    }
  }

  private async advanceCheckpoint(
    executor: PostgreSqlQueryExecutor,
    input: NativeTranscriptBatchInput,
    importedCount: number,
    skippedCount: number,
    operation: string,
  ): Promise<NativeTranscriptCheckpointRecord> {
    const result = await executor.query<CheckpointRow>({
      text: `UPDATE lcm.ingest_checkpoints
             SET last_source_ordinal = $5,
                 imported_count = imported_count + $6,
                 skipped_count = skipped_count + $7,
                 quarantined_count = quarantined_count + $8,
                 checkpoint = $9::pg_catalog.jsonb,
                 revision = revision + 1,
                 updated_at = statement_timestamp()
             WHERE project_id = $1
               AND machine_id = $2
               AND client_name = $3
               AND source_locator = $4
             RETURNING project_id, machine_id, client_name, source_locator,
                       revision, last_source_ordinal, imported_count,
                       skipped_count,
                       quarantined_count, checkpoint, updated_at`,
      values: [
        this.projectId,
        input.machineId,
        input.clientName,
        input.sourceLocator,
        input.checkpoint.lastSourceOrdinal,
        importedCount,
        skippedCount,
        input.quarantinedCount,
        JSON.stringify(input.checkpoint.checkpoint),
      ],
    }, this.context(operation));
    const row = result.rows[0];
    if (!row) {
      throw new PostgreSqlNativeTranscriptDataError(
        this.projectId,
        operation,
        "checkpoint",
      );
    }
    return checkpointFromRow(row, this.projectId, operation);
  }

  private validateKey(
    input: unknown,
    operation: string,
  ): NativeTranscriptCheckpointKey {
    const value = dataObject(
      input,
      this.projectId,
      operation,
      "checkpoint_key",
    );
    const machineId = uuid(
      value.machineId,
      this.projectId,
      operation,
      "machine_id",
    );
    const clientName = nonemptyString(
      value.clientName,
      this.projectId,
      operation,
      "client_name",
      true,
    );
    const sourceLocator = relativeSourceLocator(
      value.sourceLocator,
      this.projectId,
      operation,
      "source_locator",
    );
    return Object.freeze({ machineId, clientName, sourceLocator });
  }

  private validateBatch(
    input: NativeTranscriptBatchInput,
    operation: string,
  ): NativeTranscriptBatchInput {
    const value = dataObject(
      input,
      this.projectId,
      operation,
      "batch",
    );
    const key = this.validateKey(value, operation);
    const expectedCheckpoint = value.expectedCheckpoint === null
      ? null
      : this.validateExpectedCheckpoint(
          value.expectedCheckpoint,
          key,
          operation,
        );
    const quarantinedCount = nonnegativeInteger(
      value.quarantinedCount,
      this.projectId,
      operation,
      "quarantined_count",
    );
    const checkpointInput = dataObject(
      value.checkpoint,
      this.projectId,
      operation,
      "checkpoint_target",
    );
    const lastSourceOrdinal = nonnegativeInteger(
      checkpointInput.lastSourceOrdinal,
      this.projectId,
      operation,
      "last_source_ordinal",
    );
    const checkpoint = jsonObject(
      checkpointInput.checkpoint,
      this.projectId,
      operation,
      "checkpoint",
    );
    const records = Object.freeze(dataArray(
      value.records,
      this.projectId,
      operation,
      "records",
    ).map((record) => this.validateRecord(record, operation)));
    if (records.some((record) =>
      record.sourceOrdinal > lastSourceOrdinal)) {
      throw new PostgreSqlNativeTranscriptDataError(
        this.projectId,
        operation,
        "last_source_ordinal",
      );
    }
    return Object.freeze({
      ...key,
      expectedCheckpoint,
      records,
      checkpoint: Object.freeze({ lastSourceOrdinal, checkpoint }),
      quarantinedCount,
    });
  }

  private validateExpectedCheckpoint(
    input: unknown,
    key: NativeTranscriptCheckpointKey,
    operation: string,
  ): NativeTranscriptCheckpointRecord {
    const expected = dataObject(
      input,
      this.projectId,
      operation,
      "expected_checkpoint",
    );
    const projectId = uuid(
      expected.projectId,
      this.projectId,
      operation,
      "expected_project_id",
    );
    const machineId = uuid(
      expected.machineId,
      this.projectId,
      operation,
      "expected_machine_id",
    );
    const clientName = nonemptyString(
      expected.clientName,
      this.projectId,
      operation,
      "expected_client_name",
      true,
    );
    const sourceLocator = relativeSourceLocator(
      expected.sourceLocator,
      this.projectId,
      operation,
      "expected_source_locator",
    );
    const revision = nonnegativeInteger(
      expected.revision,
      this.projectId,
      operation,
      "expected_revision",
    );
    const lastSourceOrdinal = nonnegativeInteger(
      expected.lastSourceOrdinal,
      this.projectId,
      operation,
      "expected_last_source_ordinal",
    );
    const importedCount = nonnegativeInteger(
      expected.importedCount,
      this.projectId,
      operation,
      "expected_imported_count",
    );
    const skippedCount = nonnegativeInteger(
      expected.skippedCount,
      this.projectId,
      operation,
      "expected_skipped_count",
    );
    const quarantinedCount = nonnegativeInteger(
      expected.quarantinedCount,
      this.projectId,
      operation,
      "expected_quarantined_count",
    );
    const checkpoint = jsonObject(
      expected.checkpoint,
      this.projectId,
      operation,
      "expected_checkpoint",
    );
    const updatedAt = Object.freeze(date(
      expected.updatedAt,
      this.projectId,
      operation,
      "expected_updated_at",
    ));
    if (
      projectId !== this.projectId
      || machineId !== key.machineId
      || clientName !== key.clientName
      || sourceLocator !== key.sourceLocator
    ) {
      throw new PostgreSqlNativeTranscriptDataError(
        this.projectId,
        operation,
        "expected_checkpoint_key",
      );
    }
    return Object.freeze({
      projectId,
      machineId,
      clientName,
      sourceLocator,
      revision,
      lastSourceOrdinal,
      importedCount,
      skippedCount,
      quarantinedCount,
      checkpoint,
      updatedAt,
    });
  }

  private validateRecord(
    input: unknown,
    operation: string,
  ): CreateNativeTranscriptInput {
    const value = dataObject(
      input,
      this.projectId,
      operation,
      "record",
    );
    const formatName = nonemptyString(
      value.formatName,
      this.projectId,
      operation,
      "format_name",
      true,
    );
    const formatVersion = nonemptyString(
      value.formatVersion,
      this.projectId,
      operation,
      "format_version",
      true,
    );
    const nativeSessionId = nonemptyString(
      value.nativeSessionId,
      this.projectId,
      operation,
      "native_session_id",
      true,
    );
    const sourceOrdinal = nonnegativeInteger(
      value.sourceOrdinal,
      this.projectId,
      operation,
      "source_ordinal",
    );
    const observedAt = Object.freeze(date(
      value.observedAt,
      this.projectId,
      operation,
      "observed_at",
    ));
    const scrubberVersion = nonemptyString(
      value.scrubberVersion,
      this.projectId,
      operation,
      "scrubber_version",
      true,
    );
    const contentSha256 = digest(
      value.contentSha256,
      this.projectId,
      operation,
      "content_sha256",
    );
    const ingestKey = digest(
      value.ingestKey,
      this.projectId,
      operation,
      "ingest_key",
    );
    const payload = nativePayload(
      value.nativePayload,
      this.projectId,
      operation,
    );
    const actualContentSha256 = createHash("sha256")
      .update(canonicalNativeTranscriptJson(payload))
      .digest("hex");
    if (contentSha256 !== actualContentSha256) {
      throw new PostgreSqlNativeTranscriptDataError(
        this.projectId,
        operation,
        "content_sha256",
      );
    }
    const messageLinks = value.messageLinks === undefined
      ? undefined
      : Object.freeze(dataArray(
          value.messageLinks,
          this.projectId,
          operation,
          "message_links",
        ).map((link) => {
          const candidate = dataObject(
            link,
            this.projectId,
            operation,
            "message_link",
          );
          const sourceOrdinal = nonnegativeInteger(
            candidate.sourceOrdinal,
            this.projectId,
            operation,
            "link_source_ordinal",
          );
          if (sourceOrdinal > MAX_INT4) {
            throw new PostgreSqlNativeTranscriptDataError(
              this.projectId,
              operation,
              "link_source_ordinal",
            );
          }
          return Object.freeze({
            conversationId: nonnegativeInteger(
              candidate.conversationId,
              this.projectId,
              operation,
              "conversation_id",
            ),
            messageId: nonnegativeInteger(
              candidate.messageId,
              this.projectId,
              operation,
              "message_id",
            ),
            sourceOrdinal,
          });
        }));
    if (messageLinks) {
      const sourceOrdinals = new Set<number>();
      const messageIds = new Set<number>();
      for (const link of messageLinks) {
        if (sourceOrdinals.has(link.sourceOrdinal)) {
          throw new PostgreSqlNativeTranscriptDataError(
            this.projectId,
            operation,
            "link_source_ordinal",
          );
        }
        sourceOrdinals.add(link.sourceOrdinal);
        if (messageIds.has(link.messageId)) {
          throw new PostgreSqlNativeTranscriptDataError(
            this.projectId,
            operation,
            "message_id",
          );
        }
        messageIds.add(link.messageId);
      }
    }
    return Object.freeze({
      formatName,
      formatVersion,
      nativeSessionId,
      sourceOrdinal,
      observedAt,
      scrubberVersion,
      contentSha256,
      ingestKey,
      nativePayload: payload,
      messageLinks,
    });
  }

  private context(operation: string): PostgreSqlNativeTranscriptContext {
    return {
      domain: "native-transcripts",
      operation,
      projectId: this.projectId,
    };
  }

  private rootExecutor(): PostgreSqlNativeTranscriptExecutor | null {
    return "transaction" in this.executor
      && typeof this.executor.transaction === "function"
      ? this.executor
      : null;
  }

  private atomic<T>(
    operation: string,
    callback: (executor: PostgreSqlQueryExecutor) => Promise<T>,
  ): Promise<T> {
    const root = this.rootExecutor();
    return root
      ? root.transaction(callback, this.context(operation))
      : this.scopedSerialized(operation, async (executor) => {
          await this.assertScopedReadCommitted(executor, operation);
          return executor.savepoint(callback, this.context(operation));
        });
  }

  private async assertScopedReadCommitted(
    executor: PostgreSqlQueryExecutor,
    operation: string,
  ): Promise<void> {
    const result = await executor.query<TransactionIsolationRow>({
      text: `SELECT pg_catalog.current_setting(
                      'transaction_isolation'
                    ) AS transaction_isolation`,
    }, this.context(operation));
    const isolation = result.rows[0]?.transaction_isolation;
    if (
      typeof isolation !== "string"
      || isolation.trim().toLowerCase() !== "read committed"
    ) {
      throw new PostgreSqlNativeTranscriptDataError(
        this.projectId,
        operation,
        "transaction_isolation",
      );
    }
  }

  private read<T>(
    operation: string,
    callback: (executor: PostgreSqlQueryExecutor) => Promise<T>,
  ): Promise<T> {
    const root = this.rootExecutor();
    return root ? callback(root) : this.scopedSerialized(operation, callback);
  }

  private scopedSerialized<T>(
    operation: string,
    callback: (
      executor: PostgreSqlNativeTranscriptScopedExecutor,
    ) => Promise<T>,
  ): Promise<T> {
    if (
      this.executor.transactionScope !== "active"
      || !("savepoint" in this.executor)
      || typeof this.executor.savepoint !== "function"
    ) {
      return Promise.reject(new StorageOperationError(
        "STORAGE_TRANSACTION_SCOPE",
        "postgresql",
        this.projectId,
        "native-transcripts",
        operation,
      ));
    }
    const executor = this.executor as PostgreSqlNativeTranscriptScopedExecutor;
    const state = scopedExecutorStates.get(executor) ?? {
      tail: Promise.resolve(),
    };
    scopedExecutorStates.set(executor, state);
    const execute = state.tail.then(() => callback(executor));
    state.tail = execute.then(() => undefined, () => undefined);
    return execute;
  }
}
