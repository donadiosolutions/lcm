import type { QueryResultRow } from "pg";
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
  type NativeTranscriptRecord,
  type NativeTranscriptRepository,
} from "../contracts.js";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlOperationContext,
  PostgreSqlQueryExecutor,
  PostgreSqlTransactionScopeExecutor,
} from "./contracts.js";
import { PostgreSqlCommitOutcomeUnknownError } from "./errors.js";

const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
    (
      SELECT pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'transcript_id', link.transcript_id,
                 'conversation_id', link.conversation_id,
                 'message_id', link.message_id,
                 'source_ordinal', link.source_ordinal
               )
               ORDER BY link.source_ordinal, link.message_id
             )
      FROM lcm.transcript_messages AS link
      WHERE link.project_id = transcript.project_id
        AND link.transcript_id = transcript.transcript_id
    ),
    '[]'::pg_catalog.jsonb
  ) AS message_links
`.trim();

type PostgreSqlNativeTranscriptContext = PostgreSqlOperationContext & {
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
  return value;
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
  return candidate;
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
    || (typeof value === "number" && Number.isFinite(value))
  ) {
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
      return value.map((element) =>
        jsonValue(element, projectId, operation, field, seen, depth + 1));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new PostgreSqlNativeTranscriptDataError(projectId, operation, field);
    }
    const normalized: Record<string, JsonValue> = {};
    for (const [key, element] of Object.entries(value)) {
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
    return normalized;
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
    left.sourceOrdinal - right.sourceOrdinal
    || left.messageId - right.messageId
    || left.conversationId - right.conversationId);
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
    && actual.lastSourceOrdinal === candidate.lastSourceOrdinal
    && sameJson(actual.checkpoint, candidate.checkpoint)
    && actual.importedCount >= candidate.importedCount
    && actual.skippedCount >= candidate.skippedCount
    && actual.quarantinedCount >= candidate.quarantinedCount;
}

type CheckpointLockDisposition = "advance" | "matching-retry";

export class PostgreSqlNativeTranscriptRepository
implements NativeTranscriptRepository {
  constructor(
    private readonly executor: RepositoryExecutor,
    private readonly projectId: string,
  ) {
    uuid(projectId, projectId, "construct", "project_id");
  }

  async ingestBatch(
    input: NativeTranscriptBatchInput,
  ): Promise<NativeTranscriptBatchResult> {
    const operation = "ingestBatch";
    this.validateBatch(input, operation);
    let candidate: NativeTranscriptBatchResult | undefined;
    try {
      return await this.atomic(operation, async (transaction) => {
        const disposition = await this.lockCheckpoint(
          transaction,
          input,
          operation,
        );
        let importedCount = 0;
        let skippedCount = 0;
        for (const record of input.records) {
          if (disposition === "matching-retry") {
            await this.assertExactTranscript(
              transaction,
              input,
              record,
              operation,
            );
            skippedCount += 1;
            continue;
          }
          const inserted = await this.insertTranscript(
            transaction,
            input,
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
        const checkpoint = await this.advanceCheckpoint(
          transaction,
          input,
          importedCount,
          skippedCount,
          operation,
        );
        candidate = {
          importedCount,
          skippedCount,
          quarantinedCount: input.quarantinedCount,
          checkpoint,
        };
        return candidate;
      });
    } catch (error) {
      if (error instanceof PostgreSqlCommitOutcomeUnknownError && candidate) {
        const reconciled = await this.getCheckpoint(input).catch(() => null);
        if (
          reconciled
          && reconcilesCommittedCheckpoint(reconciled, candidate.checkpoint)
        ) {
          const exactRecords = await this.verifyExactRecords(
            input,
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
    uuid(transcriptId, this.projectId, operation, "transcript_id");
    const rows = await this.readTranscripts(operation, {
      text: `SELECT ${TRANSCRIPT_COLUMNS}
             FROM lcm.native_transcripts AS transcript
             WHERE transcript.project_id = $1
               AND transcript.transcript_id = $2`,
      values: [this.projectId, transcriptId],
    });
    return rows[0] ?? null;
  }

  async listByNativeSession(input: {
    readonly nativeSessionId: string;
  }): Promise<NativeTranscriptRecord[]> {
    const operation = "listByNativeSession";
    nonemptyString(
      input.nativeSessionId,
      this.projectId,
      operation,
      "native_session_id",
      true,
    );
    return this.readTranscripts(operation, {
      text: `SELECT ${TRANSCRIPT_COLUMNS}
             FROM lcm.native_transcripts AS transcript
             WHERE transcript.project_id = $1
               AND transcript.native_session_id_sha256 =
                   public.digest($2, 'sha256')
               AND transcript.native_session_id = $2
             ORDER BY transcript.observed_at, transcript.transcript_id`,
      values: [this.projectId, input.nativeSessionId],
    });
  }

  async listBySource(
    input: NativeTranscriptCheckpointKey,
  ): Promise<NativeTranscriptRecord[]> {
    const operation = "listBySource";
    this.validateKey(input, operation);
    return this.readTranscripts(operation, {
      text: `SELECT ${TRANSCRIPT_COLUMNS}
             FROM lcm.native_transcripts AS transcript
             WHERE transcript.project_id = $1
               AND transcript.machine_id = $2
               AND transcript.client_name = $3
               AND transcript.source_locator = $4
             ORDER BY transcript.source_ordinal, transcript.transcript_id`,
      values: [
        this.projectId,
        input.machineId,
        input.clientName,
        input.sourceLocator,
      ],
    });
  }

  async listByMessage(input: {
    readonly conversationId: number;
    readonly messageId: number;
  }): Promise<NativeTranscriptRecord[]> {
    const operation = "listByMessage";
    nonnegativeInteger(
      input.conversationId,
      this.projectId,
      operation,
      "conversation_id",
    );
    nonnegativeInteger(
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
             WHERE transcript.project_id = $1
               AND selected_link.conversation_id = $2
               AND selected_link.message_id = $3
             ORDER BY selected_link.source_ordinal, transcript.transcript_id`,
      values: [this.projectId, input.conversationId, input.messageId],
    });
  }

  async getCheckpoint(
    input: NativeTranscriptCheckpointKey,
  ): Promise<NativeTranscriptCheckpointRecord | null> {
    const operation = "getCheckpoint";
    this.validateKey(input, operation);
    return this.read(operation, async (executor) => {
      const result = await executor.query<CheckpointRow>({
        text: `SELECT project_id, machine_id, client_name, source_locator,
                      last_source_ordinal, imported_count, skipped_count,
                      quarantined_count, checkpoint, updated_at
               FROM lcm.ingest_checkpoints
               WHERE project_id = $1
                 AND machine_id = $2
                 AND client_name = $3
                 AND source_locator = $4`,
        values: [
          this.projectId,
          input.machineId,
          input.clientName,
          input.sourceLocator,
        ],
      }, this.context(operation));
      const row = result.rows[0];
      return row ? checkpointFromRow(row, this.projectId, operation) : null;
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
                       last_source_ordinal, imported_count, skipped_count,
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
      return "advance";
    }
    const locked = await executor.query<CheckpointRow>({
      text: `SELECT project_id, machine_id, client_name, source_locator,
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
    if (
      input.expectedCheckpoint !== null
      && sameCheckpoint(actual, input.expectedCheckpoint)
    ) {
      return "advance";
    }
    if (sameCheckpointTarget(actual, input.checkpoint)) {
      return "matching-retry";
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
               source_ordinal, observed_at, scrubber_version, content_sha256,
               ingest_key, native_payload
             )
             VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13::pg_catalog.jsonb
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
                      AND transcript.content_sha256 = $8
                      AND transcript.native_payload = $10::pg_catalog.jsonb
                    ) AS exact_match
             FROM lcm.native_transcripts AS transcript
             WHERE transcript.project_id = $1
               AND transcript.machine_id = $2
               AND transcript.ingest_key = $9`,
      values: [
        this.projectId,
        batch.machineId,
        batch.clientName,
        input.formatName,
        input.formatVersion,
        input.nativeSessionId,
        batch.sourceLocator,
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
                 updated_at = statement_timestamp()
             WHERE project_id = $1
               AND machine_id = $2
               AND client_name = $3
               AND source_locator = $4
             RETURNING project_id, machine_id, client_name, source_locator,
                       last_source_ordinal, imported_count, skipped_count,
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
    input: NativeTranscriptCheckpointKey,
    operation: string,
  ): void {
    uuid(input.machineId, this.projectId, operation, "machine_id");
    nonemptyString(
      input.clientName,
      this.projectId,
      operation,
      "client_name",
      true,
    );
    nonemptyString(
      input.sourceLocator,
      this.projectId,
      operation,
      "source_locator",
    );
  }

  private validateBatch(
    input: NativeTranscriptBatchInput,
    operation: string,
  ): void {
    this.validateKey(input, operation);
    if (input.expectedCheckpoint !== null) {
      this.validateExpectedCheckpoint(input, operation);
    }
    nonnegativeInteger(
      input.quarantinedCount,
      this.projectId,
      operation,
      "quarantined_count",
    );
    nonnegativeInteger(
      input.checkpoint.lastSourceOrdinal,
      this.projectId,
      operation,
      "last_source_ordinal",
    );
    jsonObject(
      input.checkpoint.checkpoint,
      this.projectId,
      operation,
      "checkpoint",
    );
    for (const record of input.records) {
      this.validateRecord(record, operation);
    }
  }

  private validateExpectedCheckpoint(
    input: NativeTranscriptBatchInput,
    operation: string,
  ): void {
    const expected = input.expectedCheckpoint!;
    uuid(expected.projectId, this.projectId, operation, "expected_project_id");
    uuid(expected.machineId, this.projectId, operation, "expected_machine_id");
    nonemptyString(
      expected.clientName,
      this.projectId,
      operation,
      "expected_client_name",
      true,
    );
    nonemptyString(
      expected.sourceLocator,
      this.projectId,
      operation,
      "expected_source_locator",
    );
    nonnegativeInteger(
      expected.lastSourceOrdinal,
      this.projectId,
      operation,
      "expected_last_source_ordinal",
    );
    nonnegativeInteger(
      expected.importedCount,
      this.projectId,
      operation,
      "expected_imported_count",
    );
    nonnegativeInteger(
      expected.skippedCount,
      this.projectId,
      operation,
      "expected_skipped_count",
    );
    nonnegativeInteger(
      expected.quarantinedCount,
      this.projectId,
      operation,
      "expected_quarantined_count",
    );
    jsonObject(
      expected.checkpoint,
      this.projectId,
      operation,
      "expected_checkpoint",
    );
    date(
      expected.updatedAt,
      this.projectId,
      operation,
      "expected_updated_at",
    );
    if (
      expected.projectId !== this.projectId
      || expected.machineId !== input.machineId
      || expected.clientName !== input.clientName
      || expected.sourceLocator !== input.sourceLocator
    ) {
      throw new PostgreSqlNativeTranscriptDataError(
        this.projectId,
        operation,
        "expected_checkpoint_key",
      );
    }
  }

  private validateRecord(
    input: CreateNativeTranscriptInput,
    operation: string,
  ): void {
    nonemptyString(
      input.formatName,
      this.projectId,
      operation,
      "format_name",
      true,
    );
    nonemptyString(
      input.formatVersion,
      this.projectId,
      operation,
      "format_version",
      true,
    );
    nonemptyString(
      input.nativeSessionId,
      this.projectId,
      operation,
      "native_session_id",
      true,
    );
    nonnegativeInteger(
      input.sourceOrdinal,
      this.projectId,
      operation,
      "source_ordinal",
    );
    date(input.observedAt, this.projectId, operation, "observed_at");
    nonemptyString(
      input.scrubberVersion,
      this.projectId,
      operation,
      "scrubber_version",
      true,
    );
    digest(
      input.contentSha256,
      this.projectId,
      operation,
      "content_sha256",
    );
    digest(input.ingestKey, this.projectId, operation, "ingest_key");
    nativePayload(input.nativePayload, this.projectId, operation);
    for (const link of input.messageLinks ?? []) {
      nonnegativeInteger(
        link.conversationId,
        this.projectId,
        operation,
        "conversation_id",
      );
      nonnegativeInteger(
        link.messageId,
        this.projectId,
        operation,
        "message_id",
      );
      nonnegativeInteger(
        link.sourceOrdinal,
        this.projectId,
        operation,
        "link_source_ordinal",
      );
    }
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
      : this.scopedSerialized(operation, (executor) =>
          executor.savepoint(callback, this.context(operation)));
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
