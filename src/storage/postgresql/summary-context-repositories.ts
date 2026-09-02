import type { QueryResultRow } from "pg";
import type {
  ContextItemRecord,
  CreateLargeFileInput,
  CreateSummaryInput,
  LargeFileRecord,
  SummaryKind,
  SummaryRecord,
  SummarySubtreeNodeRecord,
} from "../../store/summary-store.js";
import type {
  ContextRepository,
  LargeFileRepository,
  StorageDomain,
  SummaryRepository,
} from "../contracts.js";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlOperationContext,
  PostgreSqlQueryExecutor,
  PostgreSqlTransactionOptions,
  PostgreSqlTransactionScopeExecutor,
} from "./contracts.js";
import {
  derivePostgreSqlAdvisoryLockName,
  PostgreSqlWorkCoordinator,
} from "./coordination.js";
import {
  normalizePostgreSqlError,
  PostgreSqlCommitOutcomeUnknownError,
  PostgreSqlStorageOperationError,
} from "./errors.js";

const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_POSTGRESQL_INTEGER = 2_147_483_647;
const POSTGRESQL_INTEGER_PATH_WIDTH =
  MAX_POSTGRESQL_INTEGER.toString().length;
const MAX_SHORT_TRANSACTION_ATTEMPTS = 3;
const SHORT_TRANSACTION_RETRY_SQLSTATES = new Set(["40001", "40P01"]);
const INTEGRITY_SQLSTATES = new Set(["23503", "23505", "23514", "P0001"]);
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

const SUMMARY_COLUMNS = `summary_id, conversation_id, kind, depth, content,
  token_count, earliest_at, latest_at, descendant_count,
  descendant_token_count, source_message_token_count, created_at`;
const SUMMARY_SELECT = `s.summary_id, s.conversation_id, s.kind, s.depth,
  s.content, s.token_count, s.earliest_at, s.latest_at, s.descendant_count,
  s.descendant_token_count, s.source_message_token_count, s.created_at,
  COALESCE((
    SELECT pg_catalog.jsonb_agg(files.file_id ORDER BY files.ordinal)
    FROM lcm.summary_large_files AS files
    WHERE files.project_id = s.project_id
      AND files.conversation_id = s.conversation_id
      AND files.summary_key = s.summary_key
  ), '[]'::pg_catalog.jsonb) AS file_ids`;
const LARGE_FILE_COLUMNS = `file_id, conversation_id, file_name, mime_type,
  byte_size, storage_uri, exploration_summary, created_at`;

export interface PostgreSqlSummaryContextFence {
  readonly machineId: string;
  readonly processId: string;
  readonly operation: string;
  readonly fencingToken: bigint;
}

/**
 * Optional mutation controls are bound to one repository instance so the
 * backend-neutral repository method signatures remain unchanged.
 */
export interface PostgreSqlSummaryContextRepositoryOptions {
  readonly signal?: AbortSignal;
  readonly lockTimeoutMs?: number;
  readonly fence?: PostgreSqlSummaryContextFence;
}

type MutationDomain = "summaries" | "context";

type MutationContext = PostgreSqlTransactionOptions & {
  readonly domain: MutationDomain;
  readonly projectId: string;
  readonly signal?: AbortSignal;
};

export interface PostgreSqlSummaryContextExecutor
extends PostgreSqlQueryExecutor {
  transaction<T>(
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlTransactionOptions & {
      readonly projectId: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<T>;
}

export interface PostgreSqlSummaryContextScopedExecutor
extends PostgreSqlTransactionScopeExecutor {}

type RepositoryExecutor =
  | PostgreSqlSummaryContextExecutor
  | PostgreSqlSummaryContextScopedExecutor;

type ScopedExecutorState = { tail: Promise<void> };
const scopedExecutorStates = new WeakMap<
  PostgreSqlSummaryContextScopedExecutor,
  ScopedExecutorState
>();

type SummaryRow = QueryResultRow & {
  summary_id: unknown;
  conversation_id: unknown;
  kind: unknown;
  depth: unknown;
  content: unknown;
  token_count: unknown;
  file_ids: unknown;
  earliest_at: unknown;
  latest_at: unknown;
  descendant_count: unknown;
  descendant_token_count: unknown;
  source_message_token_count: unknown;
  created_at: unknown;
};

type SummaryIdentityRow = QueryResultRow & {
  summary_key: unknown;
  summary_id: unknown;
  conversation_id: unknown;
};

type SummarySubtreeRow = SummaryRow & {
  summary_key: unknown;
  edge_parent_summary_key: unknown;
  edge_ordinal: unknown;
};

type ContextItemRow = QueryResultRow & {
  conversation_id: unknown;
  ordinal: unknown;
  item_type: unknown;
  message_id: unknown;
  summary_id: unknown;
  created_at: unknown;
};

type LargeFileRow = QueryResultRow & {
  file_id: unknown;
  conversation_id: unknown;
  file_name: unknown;
  mime_type: unknown;
  byte_size: unknown;
  storage_uri: unknown;
  exploration_summary: unknown;
  created_at: unknown;
};

type CountRow = QueryResultRow & { count: unknown };
type ContextRangeRow = QueryResultRow & {
  total_count: unknown;
  range_count: unknown;
  min_ordinal: unknown;
  max_ordinal: unknown;
};
type IsolationRow = QueryResultRow & { transaction_isolation: unknown };
type SettingRow = QueryResultRow & { setting: unknown };

export class PostgreSqlSummaryContextDataError extends StorageOperationError {
  constructor(
    projectId: string,
    domain: "summaries" | "context" | "large-files",
    operation: string,
    readonly field: string,
  ) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      projectId,
      domain,
      operation,
    );
    this.name = "PostgreSqlSummaryContextDataError";
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), field: this.field };
  }
}

export class PostgreSqlSummaryContextNotFoundError
extends StorageOperationError {
  constructor(
    projectId: string,
    domain: "summaries" | "context" | "large-files",
    operation: string,
    readonly entity: "conversation" | "large-file" | "message" | "summary",
  ) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      projectId,
      domain,
      operation,
    );
    this.name = "PostgreSqlSummaryContextNotFoundError";
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), entity: this.entity };
  }
}

export class PostgreSqlSummaryContextConflictError
extends StorageOperationError {
  constructor(
    projectId: string,
    domain: "summaries" | "context" | "large-files",
    operation: string,
    readonly conflict:
      | "cross-conversation"
      | "cycle"
      | "duplicate"
      | "integrity"
      | "range",
  ) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      projectId,
      domain,
      operation,
    );
    this.name = "PostgreSqlSummaryContextConflictError";
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), conflict: this.conflict };
  }
}

function sqlState(error: unknown): string | null {
  if (error instanceof PostgreSqlStorageOperationError) return error.sqlState;
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)
    ? code
    : null;
}

function safeInteger(
  value: unknown,
  projectId: string,
  domain: "summaries" | "context" | "large-files",
  operation: string,
  field: string,
): number {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return value;
    throw new PostgreSqlSummaryContextDataError(
      projectId,
      domain,
      operation,
      field,
    );
  }
  if (
    (typeof value !== "string" || !/^-?\d+$/u.test(value))
    && typeof value !== "bigint"
  ) {
    throw new PostgreSqlSummaryContextDataError(
      projectId,
      domain,
      operation,
      field,
    );
  }
  const candidate = typeof value === "bigint" ? value : BigInt(value);
  if (candidate < MIN_SAFE_BIGINT || candidate > MAX_SAFE_BIGINT) {
    throw new PostgreSqlSummaryContextDataError(
      projectId,
      domain,
      operation,
      field,
    );
  }
  return Number(candidate);
}

function safeNonnegativeInput(
  value: number,
  projectId: string,
  domain: "summaries" | "context" | "large-files",
  operation: string,
  field: string,
): number {
  const candidate = safeInteger(value, projectId, domain, operation, field);
  if (candidate < 0) {
    throw new PostgreSqlSummaryContextDataError(
      projectId,
      domain,
      operation,
      field,
    );
  }
  return candidate;
}

function safeOrdinalInput(
  value: number,
  projectId: string,
  operation: string,
  field: string,
): number {
  const candidate = safeNonnegativeInput(
    value,
    projectId,
    "context",
    operation,
    field,
  );
  if (candidate > MAX_POSTGRESQL_INTEGER) {
    throw new PostgreSqlSummaryContextDataError(
      projectId,
      "context",
      operation,
      field,
    );
  }
  return candidate;
}

function optionalMetric(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    ? Math.floor(value)
    : fallback;
}

function containsMalformedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (
        !Number.isInteger(following)
        || following < 0xdc00
        || following > 0xdfff
      ) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function text(
  value: unknown,
  projectId: string,
  domain: "summaries" | "context" | "large-files",
  operation: string,
  field: string,
): string {
  if (
    typeof value !== "string"
    || value.includes("\0")
    || containsMalformedUtf16(value)
  ) {
    throw new PostgreSqlSummaryContextDataError(
      projectId,
      domain,
      operation,
      field,
    );
  }
  return value;
}

function nullableText(
  value: unknown,
  projectId: string,
  domain: "summaries" | "context" | "large-files",
  operation: string,
  field: string,
): string | null {
  return value === null
    ? null
    : text(value, projectId, domain, operation, field);
}

function date(
  value: unknown,
  projectId: string,
  domain: "summaries" | "context" | "large-files",
  operation: string,
  field: string,
): Date {
  const parsed = value instanceof Date
    ? new Date(value.getTime())
    : new Date(text(value, projectId, domain, operation, field));
  if (!Number.isFinite(parsed.getTime())) {
    throw new PostgreSqlSummaryContextDataError(
      projectId,
      domain,
      operation,
      field,
    );
  }
  return parsed;
}

function nullableDate(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
): Date | null {
  return value === null
    ? null
    : date(value, projectId, "summaries", operation, field);
}

function summaryKind(
  value: unknown,
  projectId: string,
  operation: string,
): SummaryKind {
  if (value === "leaf" || value === "condensed") return value;
  throw new PostgreSqlSummaryContextDataError(
    projectId,
    "summaries",
    operation,
    "kind",
  );
}

function fileIds(
  value: unknown,
  projectId: string,
  operation: string,
): string[] {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      throw new PostgreSqlSummaryContextDataError(
        projectId,
        "summaries",
        operation,
        "file_ids",
      );
    }
  }
  if (
    !Array.isArray(candidate)
    || candidate.some((item) =>
      typeof item !== "string"
      || item.includes("\0")
      || containsMalformedUtf16(item))
  ) {
    throw new PostgreSqlSummaryContextDataError(
      projectId,
      "summaries",
      operation,
      "file_ids",
    );
  }
  return [...candidate];
}

function summaryFromRow(
  row: SummaryRow,
  projectId: string,
  operation: string,
): SummaryRecord {
  return {
    summaryId: text(
      row.summary_id,
      projectId,
      "summaries",
      operation,
      "summary_id",
    ),
    conversationId: safeInteger(
      row.conversation_id,
      projectId,
      "summaries",
      operation,
      "conversation_id",
    ),
    kind: summaryKind(row.kind, projectId, operation),
    depth: safeInteger(
      row.depth,
      projectId,
      "summaries",
      operation,
      "depth",
    ),
    content: text(
      row.content,
      projectId,
      "summaries",
      operation,
      "content",
    ),
    tokenCount: safeInteger(
      row.token_count,
      projectId,
      "summaries",
      operation,
      "token_count",
    ),
    fileIds: fileIds(row.file_ids, projectId, operation),
    earliestAt: nullableDate(row.earliest_at, projectId, operation, "earliest_at"),
    latestAt: nullableDate(row.latest_at, projectId, operation, "latest_at"),
    descendantCount: safeInteger(
      row.descendant_count,
      projectId,
      "summaries",
      operation,
      "descendant_count",
    ),
    descendantTokenCount: safeInteger(
      row.descendant_token_count,
      projectId,
      "summaries",
      operation,
      "descendant_token_count",
    ),
    sourceMessageTokenCount: safeInteger(
      row.source_message_token_count,
      projectId,
      "summaries",
      operation,
      "source_message_token_count",
    ),
    createdAt: date(
      row.created_at,
      projectId,
      "summaries",
      operation,
      "created_at",
    ),
  };
}

function contextItemFromRow(
  row: ContextItemRow,
  projectId: string,
  operation: string,
): ContextItemRecord {
  const itemType = row.item_type;
  if (itemType !== "message" && itemType !== "summary") {
    throw new PostgreSqlSummaryContextDataError(
      projectId,
      "context",
      operation,
      "item_type",
    );
  }
  const messageId = row.message_id === null
    ? null
    : safeInteger(
      row.message_id,
      projectId,
      "context",
      operation,
      "message_id",
    );
  const summaryId = row.summary_id === null
    ? null
    : text(
      row.summary_id,
      projectId,
      "context",
      operation,
      "summary_id",
    );
  if (
    (itemType === "message" && (messageId === null || summaryId !== null))
    || (itemType === "summary" && (messageId !== null || summaryId === null))
  ) {
    throw new PostgreSqlSummaryContextDataError(
      projectId,
      "context",
      operation,
      "item_reference",
    );
  }
  return {
    conversationId: safeInteger(
      row.conversation_id,
      projectId,
      "context",
      operation,
      "conversation_id",
    ),
    ordinal: safeInteger(
      row.ordinal,
      projectId,
      "context",
      operation,
      "ordinal",
    ),
    itemType,
    messageId,
    summaryId,
    createdAt: date(
      row.created_at,
      projectId,
      "context",
      operation,
      "created_at",
    ),
  };
}

function largeFileFromRow(
  row: LargeFileRow,
  projectId: string,
  operation: string,
): LargeFileRecord {
  return {
    fileId: text(
      row.file_id,
      projectId,
      "large-files",
      operation,
      "file_id",
    ),
    conversationId: safeInteger(
      row.conversation_id,
      projectId,
      "large-files",
      operation,
      "conversation_id",
    ),
    fileName: nullableText(
      row.file_name,
      projectId,
      "large-files",
      operation,
      "file_name",
    ),
    mimeType: nullableText(
      row.mime_type,
      projectId,
      "large-files",
      operation,
      "mime_type",
    ),
    byteSize: row.byte_size === null
      ? null
      : safeInteger(
          row.byte_size,
          projectId,
          "large-files",
          operation,
          "byte_size",
        ),
    storageUri: text(
      row.storage_uri,
      projectId,
      "large-files",
      operation,
      "storage_uri",
    ),
    explorationSummary: nullableText(
      row.exploration_summary,
      projectId,
      "large-files",
      operation,
      "exploration_summary",
    ),
    createdAt: date(
      row.created_at,
      projectId,
      "large-files",
      operation,
      "created_at",
    ),
  };
}

function rejectDuplicateValues(
  values: readonly (number | string)[],
  projectId: string,
  domain: "summaries" | "context",
  operation: string,
): void {
  if (new Set(values).size !== values.length) {
    throw new PostgreSqlSummaryContextConflictError(
      projectId,
      domain,
      operation,
      "duplicate",
    );
  }
}

function validateOpaqueText(
  value: unknown,
  projectId: string,
  domain: "summaries" | "context" | "large-files",
  operation: string,
  field: string,
  optional = false,
): void {
  if (optional && (value === null || value === undefined)) return;
  if (
    typeof value !== "string"
    || value.includes("\0")
    || containsMalformedUtf16(value)
  ) {
    throw new PostgreSqlSummaryContextDataError(
      projectId,
      domain,
      operation,
      field,
    );
  }
}

class RepositoryCore {
  readonly signal: AbortSignal | undefined;
  readonly lockTimeoutMs: number;
  readonly fence: PostgreSqlSummaryContextFence | undefined;

  constructor(
    readonly executor: RepositoryExecutor,
    readonly projectId: string,
    options: PostgreSqlSummaryContextRepositoryOptions = {},
  ) {
    this.signal = options.signal;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.fence = options.fence === undefined
      ? undefined
      : {
          machineId: options.fence.machineId,
          processId: options.fence.processId,
          operation: options.fence.operation,
          fencingToken: options.fence.fencingToken,
        };
    if (
      !Number.isSafeInteger(this.lockTimeoutMs)
      || this.lockTimeoutMs <= 0
    ) {
      throw new PostgreSqlSummaryContextDataError(
        projectId,
        "summaries",
        "construct",
        "lock_timeout_ms",
      );
    }
    if (
      typeof projectId !== "string"
      || !projectId
      || projectId.includes("\0")
      || containsMalformedUtf16(projectId)
    ) {
      throw new PostgreSqlSummaryContextDataError(
        projectId,
        "summaries",
        "construct",
        "project_id",
      );
    }
    if (this.fence !== undefined) {
      validateOpaqueText(
        this.fence.machineId,
        projectId,
        "summaries",
        "construct",
        "machine_id",
      );
      validateOpaqueText(
        this.fence.processId,
        projectId,
        "summaries",
        "construct",
        "owner_process_id",
      );
      validateOpaqueText(
        this.fence.operation,
        projectId,
        "summaries",
        "construct",
        "lease_operation",
      );
      if (
        this.fence.machineId.trim() === ""
        || this.fence.processId.trim() === ""
        || this.fence.operation.trim() === ""
        || typeof this.fence.fencingToken !== "bigint"
        || this.fence.fencingToken < 1n
      ) {
        throw new PostgreSqlSummaryContextDataError(
          projectId,
          "summaries",
          "construct",
          "fence",
        );
      }
    }
  }

  context(
    domain: StorageDomain,
    operation: string,
  ): PostgreSqlOperationContext & { projectId: string; signal?: AbortSignal } {
    return {
      domain,
      operation,
      projectId: this.projectId,
      ...(this.fence === undefined
        ? {}
        : { machineId: this.fence.machineId }),
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    };
  }

  async read<T>(
    domain: "summaries" | "context" | "large-files",
    operation: string,
    callback: (executor: PostgreSqlQueryExecutor) => Promise<T>,
  ): Promise<T> {
    try {
      const root = this.rootExecutor();
      return root
        ? await callback(root)
        : await this.serializedScoped(operation, callback);
    } catch (error) {
      throw this.mappedError(error, domain, operation);
    }
  }

  async atomic<T>(
    domain: "summaries" | "large-files",
    operation: string,
    callback: (executor: PostgreSqlQueryExecutor) => Promise<T>,
  ): Promise<T> {
    try {
      const root = this.rootExecutor();
      if (root) {
        let attempt = 1;
        while (true) {
          try {
            return await root.transaction(
              callback,
              this.context(domain, operation),
            );
          } catch (error) {
            if (error instanceof PostgreSqlCommitOutcomeUnknownError) {
              throw error;
            }
            if (
              attempt === MAX_SHORT_TRANSACTION_ATTEMPTS
              || !SHORT_TRANSACTION_RETRY_SQLSTATES.has(sqlState(error) ?? "")
            ) {
              throw error;
            }
            attempt += 1;
          }
        }
      }
      return await this.serializedScoped(operation, async (executor) => {
        await this.assertReadCommitted(executor, domain, operation);
        return executor.savepoint(callback, this.context(domain, operation));
      });
    } catch (error) {
      throw this.mappedError(error, domain, operation);
    }
  }

  async mutation<T>(
    domain: MutationDomain,
    operation: string,
    conversationId: number,
    callback: (executor: PostgreSqlQueryExecutor) => Promise<T>,
  ): Promise<T> {
    safeNonnegativeInput(
      conversationId,
      this.projectId,
      domain,
      operation,
      "conversation_id",
    );
    const execute = async (
      transaction: PostgreSqlSummaryContextScopedExecutor,
      nested: boolean,
    ): Promise<T> => {
      if (nested) {
        await this.assertReadCommitted(transaction, domain, operation);
      }
      await this.acquireConversationLock(
        transaction,
        domain,
        operation,
        conversationId,
      );
      if (this.fence !== undefined) {
        await new PostgreSqlWorkCoordinator(
          transaction,
          this.projectId,
          this.fence.machineId,
        ).assertLeaseFence({
          resourceType: "conversation",
          resourceKey: conversationId.toString(),
          processId: this.fence.processId,
          operation: this.fence.operation,
          fencingToken: this.fence.fencingToken,
          ...(this.signal === undefined ? {} : { signal: this.signal }),
        });
      }
      return nested
        ? transaction.savepoint(
            callback,
            this.context(domain, operation),
          )
        : callback(transaction);
    };

    try {
      const root = this.rootExecutor();
      if (root) {
        let attempt = 1;
        while (true) {
          try {
            return await root.transaction(
              (transaction) => execute(transaction, false),
              this.context(domain, operation) as MutationContext,
            );
          } catch (error) {
            if (error instanceof PostgreSqlCommitOutcomeUnknownError) {
              throw error;
            }
            if (
              attempt === MAX_SHORT_TRANSACTION_ATTEMPTS
              || !SHORT_TRANSACTION_RETRY_SQLSTATES.has(sqlState(error) ?? "")
            ) {
              throw error;
            }
            attempt += 1;
          }
        }
      }
      return await this.serializedScoped(
        operation,
        (transaction) => execute(transaction, true),
      );
    } catch (error) {
      throw this.mappedError(error, domain, operation);
    }
  }

  private async acquireConversationLock(
    transaction: PostgreSqlSummaryContextScopedExecutor,
    domain: MutationDomain,
    operation: string,
    conversationId: number,
  ): Promise<void> {
    const prior = await transaction.query<SettingRow>({
      text: `SELECT pg_catalog.current_setting('lock_timeout') AS setting`,
    }, this.context(domain, operation));
    const previous = text(
      prior.rows[0]?.setting,
      this.projectId,
      domain,
      operation,
      "lock_timeout",
    );
    let failure: { readonly error: unknown } | undefined;
    await transaction.query({
      text: `SELECT pg_catalog.set_config(
                      'lock_timeout',
                      $1::pg_catalog.text,
                      true
                    )`,
      values: [`${this.lockTimeoutMs}ms`],
    }, this.context(domain, operation));
    try {
      await transaction.savepoint(async (savepoint) => {
        await savepoint.query({
          text: `SELECT pg_catalog.pg_advisory_xact_lock(
                          pg_catalog.hashtextextended(
                            $1::pg_catalog.text,
                            0
                          )
                        )`,
          values: [
            derivePostgreSqlAdvisoryLockName(
              this.projectId,
              "conversation",
              conversationId.toString(),
            ),
          ],
        }, this.context(domain, operation));
      }, this.context(domain, operation));
    } catch (error) {
      failure = { error };
    } finally {
      try {
        await transaction.query({
          text: `SELECT pg_catalog.set_config(
                          'lock_timeout',
                          $1::pg_catalog.text,
                          true
                        )`,
          values: [previous],
        }, this.context(domain, operation));
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure !== undefined) throw failure.error;
  }

  private async assertReadCommitted(
    executor: PostgreSqlQueryExecutor,
    domain: "summaries" | "context" | "large-files",
    operation: string,
  ): Promise<void> {
    const result = await executor.query<IsolationRow>({
      text: `SELECT pg_catalog.current_setting(
                      'transaction_isolation'
                    ) AS transaction_isolation`,
    }, this.context(domain, operation));
    if (result.rows[0]?.transaction_isolation !== "read committed") {
      throw new PostgreSqlSummaryContextDataError(
        this.projectId,
        domain,
        operation,
        "transaction_isolation",
      );
    }
  }

  private rootExecutor(): PostgreSqlSummaryContextExecutor | null {
    return "transaction" in this.executor
      && typeof this.executor.transaction === "function"
      ? this.executor
      : null;
  }

  private serializedScoped<T>(
    operation: string,
    callback: (
      executor: PostgreSqlSummaryContextScopedExecutor,
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
        "transaction",
        operation,
      ));
    }
    const executor = this.executor as PostgreSqlSummaryContextScopedExecutor;
    const existing = scopedExecutorStates.get(executor);
    const state = existing ?? { tail: Promise.resolve() };
    if (!existing) scopedExecutorStates.set(executor, state);
    const executing = state.tail.then(() => callback(executor));
    state.tail = executing.then(() => undefined, () => undefined);
    return executing;
  }

  private mappedError(
    error: unknown,
    domain: "summaries" | "context" | "large-files",
    operation: string,
  ): StorageOperationError {
    if (
      error instanceof PostgreSqlSummaryContextDataError
      || error instanceof PostgreSqlSummaryContextNotFoundError
      || error instanceof PostgreSqlSummaryContextConflictError
      || (
        error instanceof StorageOperationError
        && !(error instanceof PostgreSqlStorageOperationError)
      )
    ) {
      return error;
    }
    if (INTEGRITY_SQLSTATES.has(sqlState(error) ?? "")) {
      return new PostgreSqlSummaryContextConflictError(
        this.projectId,
        domain,
        operation,
        sqlState(error) === "P0001" ? "cycle" : "integrity",
      );
    }
    return normalizePostgreSqlError(
      error,
      this.context(domain, operation),
    );
  }
}

function summaryIdentity(
  row: SummaryIdentityRow,
  projectId: string,
  operation: string,
): { summaryKey: string; summaryId: string; conversationId: number } {
  return {
    summaryKey: text(
      row.summary_key,
      projectId,
      "summaries",
      operation,
      "summary_key",
    ),
    summaryId: text(
      row.summary_id,
      projectId,
      "summaries",
      operation,
      "summary_id",
    ),
    conversationId: safeInteger(
      row.conversation_id,
      projectId,
      "summaries",
      operation,
      "conversation_id",
    ),
  };
}

async function findExactSummaryIdentity(
  executor: PostgreSqlQueryExecutor,
  core: RepositoryCore,
  domain: "summaries" | "context",
  operation: string,
  summaryId: string,
): Promise<{
  summaryKey: string;
  summaryId: string;
  conversationId: number;
} | null> {
  validateOpaqueText(summaryId, core.projectId, domain, operation, "summary_id");
  const result = await executor.query<SummaryIdentityRow>({
    text: `SELECT summary_key, summary_id, conversation_id
           FROM lcm.summaries
           WHERE project_id = $1
             AND summary_id_sha256 = public.digest($2, 'sha256')
             AND summary_id = $2
           ORDER BY summary_key
           LIMIT 2`,
    values: [core.projectId, summaryId],
  }, core.context(domain, operation));
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1 || !result.rows[0]) {
    throw new PostgreSqlSummaryContextConflictError(
      core.projectId,
      domain,
      operation,
      "integrity",
    );
  }
  return summaryIdentity(result.rows[0], core.projectId, operation);
}

async function exactSummaryIdentity(
  executor: PostgreSqlQueryExecutor,
  core: RepositoryCore,
  domain: "summaries" | "context",
  operation: string,
  summaryId: string,
): Promise<{ summaryKey: string; summaryId: string; conversationId: number }> {
  const identity = await findExactSummaryIdentity(
    executor,
    core,
    domain,
    operation,
    summaryId,
  );
  if (identity === null) {
    throw new PostgreSqlSummaryContextNotFoundError(
      core.projectId,
      domain,
      operation,
      "summary",
    );
  }
  return identity;
}

export class PostgreSqlSummaryRepository implements SummaryRepository {
  private readonly core: RepositoryCore;

  constructor(
    executor: RepositoryExecutor,
    readonly projectId: string,
    options: PostgreSqlSummaryContextRepositoryOptions = {},
  ) {
    this.core = new RepositoryCore(executor, projectId, options);
  }

  async insertSummary(input: CreateSummaryInput): Promise<SummaryRecord> {
    const operation = "insertSummary";
    const snapshot: CreateSummaryInput = {
      ...input,
      ...(input.fileIds === undefined ? {} : { fileIds: [...input.fileIds] }),
      ...(input.earliestAt === undefined
        ? {}
        : {
            earliestAt: input.earliestAt instanceof Date
              ? new Date(input.earliestAt.getTime())
              : input.earliestAt,
          }),
      ...(input.latestAt === undefined
        ? {}
        : {
            latestAt: input.latestAt instanceof Date
              ? new Date(input.latestAt.getTime())
              : input.latestAt,
          }),
    };
    this.validateSummaryInput(snapshot, operation);
    return this.core.mutation(
      "summaries",
      operation,
      snapshot.conversationId,
      async (transaction) => {
        const depth = optionalMetric(
          snapshot.depth,
          snapshot.kind === "leaf" ? 0 : 1,
        );
        const result = await transaction.query<SummaryRow>({
          text: `INSERT INTO lcm.summaries (
                   summary_id, project_id, conversation_id, kind, depth,
                   content, token_count, earliest_at, latest_at,
                   descendant_count, descendant_token_count,
                   source_message_token_count
                 )
                 SELECT $2, $1, conversation.conversation_id, $4, $5, $6, $7,
                        $8, $9, $10, $11, $12
                 FROM lcm.conversations AS conversation
                 WHERE conversation.project_id = $1
                   AND conversation.conversation_id = $3
                 RETURNING ${SUMMARY_COLUMNS}, '[]'::pg_catalog.jsonb AS file_ids`,
          values: [
            this.projectId,
            snapshot.summaryId,
            snapshot.conversationId,
            snapshot.kind,
            depth,
            snapshot.content,
            snapshot.tokenCount,
            snapshot.earliestAt ?? null,
            snapshot.latestAt ?? null,
            optionalMetric(snapshot.descendantCount, 0),
            optionalMetric(snapshot.descendantTokenCount, 0),
            optionalMetric(snapshot.sourceMessageTokenCount, 0),
          ],
        }, this.core.context("summaries", operation));
        const row = result.rows[0];
        if (!row) {
          throw new PostgreSqlSummaryContextNotFoundError(
            this.projectId,
            "summaries",
            operation,
            "conversation",
          );
        }
        const requestedFileIds = snapshot.fileIds ?? [];
        if (requestedFileIds.length > 0) {
          await transaction.query({
            text: `INSERT INTO lcm.summary_large_files (
                     project_id, conversation_id, summary_key, file_id, ordinal
                   )
                   SELECT $1, $3, inserted.summary_key, files.file_id,
                          files.input_ordinal - 1
                   FROM lcm.summaries AS inserted
                   CROSS JOIN pg_catalog.jsonb_array_elements_text(
                     $4::pg_catalog.jsonb
                   ) WITH ORDINALITY AS files(file_id, input_ordinal)
                   WHERE inserted.project_id = $1
                     AND inserted.conversation_id = $3
                     AND inserted.summary_id_sha256 =
                       public.digest($2, 'sha256')
                     AND inserted.summary_id = $2
                   ORDER BY files.input_ordinal`,
            values: [
              this.projectId,
              snapshot.summaryId,
              snapshot.conversationId,
              JSON.stringify(requestedFileIds),
            ],
          }, this.core.context("summaries", operation));
        }
        return summaryFromRow(
          { ...row, file_ids: [...requestedFileIds] },
          this.projectId,
          operation,
        );
      },
    );
  }

  async getSummary(summaryId: string): Promise<SummaryRecord | null> {
    const operation = "getSummary";
    validateOpaqueText(summaryId, this.projectId, "summaries", operation, "summary_id");
    return this.core.read("summaries", operation, async (executor) => {
      const result = await executor.query<SummaryRow>({
        text: `SELECT ${SUMMARY_SELECT}
               FROM lcm.summaries AS s
               WHERE s.project_id = $1
                 AND s.summary_id_sha256 = public.digest($2, 'sha256')
                 AND s.summary_id = $2
               ORDER BY s.summary_key
               LIMIT 2`,
        values: [this.projectId, summaryId],
      }, this.core.context("summaries", operation));
      if (result.rows.length > 1) {
        throw new PostgreSqlSummaryContextConflictError(
          this.projectId,
          "summaries",
          operation,
          "integrity",
        );
      }
      return result.rows[0]
        ? summaryFromRow(result.rows[0], this.projectId, operation)
        : null;
    });
  }

  async getSummariesByConversation(
    conversationId: number,
  ): Promise<SummaryRecord[]> {
    const operation = "getSummariesByConversation";
    safeNonnegativeInput(
      conversationId,
      this.projectId,
      "summaries",
      operation,
      "conversation_id",
    );
    return this.list(operation, `s.conversation_id = $2`, [
      this.projectId,
      conversationId,
    ], "s.created_at, s.summary_key");
  }

  async listRecentSummaries(limit: number): Promise<SummaryRecord[]> {
    const operation = "listRecentSummaries";
    safeInteger(limit, this.projectId, "summaries", operation, "limit");
    return this.list(
      operation,
      "TRUE",
      [this.projectId, ...(limit < 0 ? [] : [limit])],
      "s.created_at DESC, s.summary_key DESC",
      limit < 0 ? "" : "LIMIT $2",
    );
  }

  async listRecentSummariesForSession(
    sessionId: string,
    limit: number,
  ): Promise<SummaryRecord[]> {
    const operation = "listRecentSummariesForSession";
    validateOpaqueText(sessionId, this.projectId, "summaries", operation, "session_id");
    safeInteger(limit, this.projectId, "summaries", operation, "limit");
    return this.core.read("summaries", operation, async (executor) => {
      const result = await executor.query<SummaryRow>({
        text: `SELECT ${SUMMARY_SELECT}
               FROM lcm.summaries AS s
               INNER JOIN lcm.conversations AS conversation
                 ON conversation.project_id = s.project_id
                 AND conversation.conversation_id = s.conversation_id
               WHERE s.project_id = $1
                 AND conversation.session_id_sha256 =
                   public.digest($2, 'sha256')
                 AND conversation.session_id = $2
               ORDER BY s.depth DESC, s.created_at DESC, s.summary_key DESC
               ${limit < 0 ? "" : "LIMIT $3"}`,
        values: [
          this.projectId,
          sessionId,
          ...(limit < 0 ? [] : [limit]),
        ],
      }, this.core.context("summaries", operation));
      return result.rows.map((row) =>
        summaryFromRow(row, this.projectId, operation));
    });
  }

  async linkSummaryToMessages(
    summaryId: string,
    messageIds: number[],
  ): Promise<void> {
    const messageIdSnapshot = [...messageIds];
    const operation = "linkSummaryToMessages";
    validateOpaqueText(
      summaryId,
      this.projectId,
      "summaries",
      operation,
      "summary_id",
    );
    if (messageIdSnapshot.length === 0) return;
    for (const messageId of messageIdSnapshot) {
      safeNonnegativeInput(
        messageId,
        this.projectId,
        "summaries",
        operation,
        "message_id",
      );
    }
    rejectDuplicateValues(
      messageIdSnapshot,
      this.projectId,
      "summaries",
      operation,
    );
    const identity = await this.core.read(
      "summaries",
      operation,
      (executor) => exactSummaryIdentity(
        executor,
        this.core,
        "summaries",
        operation,
        summaryId,
      ),
    );
    await this.core.mutation(
      "summaries",
      operation,
      identity.conversationId,
      async (transaction) => {
        const current = await exactSummaryIdentity(
          transaction,
          this.core,
          "summaries",
          operation,
          summaryId,
        );
        if (current.conversationId !== identity.conversationId) {
          throw new PostgreSqlSummaryContextConflictError(
            this.projectId,
            "summaries",
            operation,
            "cross-conversation",
          );
        }
        const inserted = await transaction.query({
          text: `WITH input AS (
                   SELECT message.message_id, message.input_ordinal - 1 AS ordinal
                   FROM pg_catalog.jsonb_array_elements_text(
                     $4::pg_catalog.jsonb
                   ) WITH ORDINALITY AS message(message_id, input_ordinal)
                 )
                 INSERT INTO lcm.summary_messages (
                   project_id, conversation_id, summary_key, message_id, ordinal
                 )
                 SELECT $1, $2, $3, stored.message_id, input.ordinal
                 FROM input
                 INNER JOIN lcm.messages AS stored
                   ON stored.project_id = $1
                   AND stored.conversation_id = $2
                   AND stored.message_id =
                     input.message_id::pg_catalog.int8
                 ORDER BY input.ordinal
                 RETURNING message_id`,
          values: [
            this.projectId,
            current.conversationId,
            current.summaryKey,
            JSON.stringify(messageIdSnapshot),
          ],
        }, this.core.context("summaries", operation));
        if (inserted.rows.length !== messageIdSnapshot.length) {
          throw new PostgreSqlSummaryContextNotFoundError(
            this.projectId,
            "summaries",
            operation,
            "message",
          );
        }
      },
    );
  }

  async linkSummaryToParents(
    summaryId: string,
    parentSummaryIds: string[],
  ): Promise<void> {
    const parentIdSnapshot = [...parentSummaryIds];
    const operation = "linkSummaryToParents";
    validateOpaqueText(summaryId, this.projectId, "summaries", operation, "summary_id");
    if (parentIdSnapshot.length === 0) return;
    for (const parentId of parentIdSnapshot) {
      validateOpaqueText(parentId, this.projectId, "summaries", operation, "parent_summary_id");
    }
    rejectDuplicateValues(
      parentIdSnapshot,
      this.projectId,
      "summaries",
      operation,
    );
    if (parentIdSnapshot.includes(summaryId)) {
      throw new PostgreSqlSummaryContextConflictError(
        this.projectId,
        "summaries",
        operation,
        "cycle",
      );
    }
    const identity = await this.core.read(
      "summaries",
      operation,
      (executor) => exactSummaryIdentity(
        executor,
        this.core,
        "summaries",
        operation,
        summaryId,
      ),
    );
    await this.core.mutation(
      "summaries",
      operation,
      identity.conversationId,
      async (transaction) => {
        const current = await exactSummaryIdentity(
          transaction,
          this.core,
          "summaries",
          operation,
          summaryId,
        );
        const parents = await transaction.query<SummaryIdentityRow>({
          text: `WITH input AS (
                   SELECT parent.summary_id, parent.input_ordinal
                   FROM pg_catalog.jsonb_array_elements_text(
                     $2::pg_catalog.jsonb
                   ) WITH ORDINALITY AS parent(summary_id, input_ordinal)
                 )
                 SELECT stored.summary_key, stored.summary_id,
                        stored.conversation_id
                 FROM input
                 INNER JOIN lcm.summaries AS stored
                   ON stored.project_id = $1
                   AND stored.summary_id_sha256 =
                     public.digest(input.summary_id, 'sha256')
                   AND stored.summary_id = input.summary_id
                 ORDER BY input.input_ordinal`,
          values: [this.projectId, JSON.stringify(parentIdSnapshot)],
        }, this.core.context("summaries", operation));
        if (parents.rows.length !== parentIdSnapshot.length) {
          throw new PostgreSqlSummaryContextNotFoundError(
            this.projectId,
            "summaries",
            operation,
            "summary",
          );
        }
        const parentIdentities = parents.rows.map((row) =>
          summaryIdentity(row, this.projectId, operation));
        if (
          parentIdentities.some(
            (parent) => parent.conversationId !== current.conversationId,
          )
        ) {
          throw new PostgreSqlSummaryContextConflictError(
            this.projectId,
            "summaries",
            operation,
            "cross-conversation",
          );
        }
        const cyclic = await transaction.query<CountRow>({
          text: `WITH RECURSIVE descendants(summary_key) AS (
                   SELECT $3::pg_catalog.uuid
                   UNION
                   SELECT edge.summary_key
                   FROM lcm.summary_parents AS edge
                   INNER JOIN descendants
                     ON descendants.summary_key = edge.parent_summary_key
                   WHERE edge.project_id = $1
                     AND edge.conversation_id = $2
                 )
                 SELECT COUNT(*) AS count
                 FROM descendants
                 WHERE summary_key = ANY($4::pg_catalog.uuid[])`,
          values: [
            this.projectId,
            current.conversationId,
            current.summaryKey,
            parentIdentities.map((parent) => parent.summaryKey),
          ],
        }, this.core.context("summaries", operation));
        if (
          safeInteger(
            cyclic.rows[0]?.count ?? 0,
            this.projectId,
            "summaries",
            operation,
            "cycle_count",
          ) !== 0
        ) {
          throw new PostgreSqlSummaryContextConflictError(
            this.projectId,
            "summaries",
            operation,
            "cycle",
          );
        }
        await transaction.query({
          text: `WITH input AS (
                   SELECT parent.summary_key::pg_catalog.uuid AS summary_key,
                          parent.input_ordinal - 1 AS ordinal
                   FROM pg_catalog.jsonb_to_recordset(
                     $4::pg_catalog.jsonb
                   ) AS parent(
                     summary_key pg_catalog.text,
                     input_ordinal pg_catalog.int8
                   )
                 )
                 INSERT INTO lcm.summary_parents (
                   project_id, conversation_id, summary_key,
                   parent_summary_key, ordinal
                 )
                 SELECT $1, $2, $3, input.summary_key, input.ordinal
                 FROM input
                 ORDER BY input.ordinal`,
          values: [
            this.projectId,
            current.conversationId,
            current.summaryKey,
            JSON.stringify(parentIdentities.map((parent, index) => ({
              summary_key: parent.summaryKey,
              input_ordinal: index + 1,
            }))),
          ],
        }, this.core.context("summaries", operation));
      },
    );
  }

  async getSummaryMessages(summaryId: string): Promise<number[]> {
    const operation = "getSummaryMessages";
    return this.core.read("summaries", operation, async (executor) => {
      const identity = await findExactSummaryIdentity(
        executor,
        this.core,
        "summaries",
        operation,
        summaryId,
      );
      if (identity === null) return [];
      const result = await executor.query<{ message_id: unknown }>({
        text: `SELECT message_id
               FROM lcm.summary_messages
               WHERE project_id = $1
                 AND conversation_id = $2
                 AND summary_key = $3
               ORDER BY ordinal, message_id`,
        values: [
          this.projectId,
          identity.conversationId,
          identity.summaryKey,
        ],
      }, this.core.context("summaries", operation));
      return result.rows.map((row) =>
        safeInteger(
          row.message_id,
          this.projectId,
          "summaries",
          operation,
          "message_id",
        ));
    });
  }

  async getSummaryChildren(
    parentSummaryId: string,
  ): Promise<SummaryRecord[]> {
    return this.relatedSummaries(
      "getSummaryChildren",
      parentSummaryId,
      `edge.parent_summary_key = $3`,
      "edge.summary_key = s.summary_key",
    );
  }

  async getSummaryParents(summaryId: string): Promise<SummaryRecord[]> {
    return this.relatedSummaries(
      "getSummaryParents",
      summaryId,
      `edge.summary_key = $3`,
      "edge.parent_summary_key = s.summary_key",
    );
  }

  async getSummarySubtree(
    summaryId: string,
  ): Promise<SummarySubtreeNodeRecord[]> {
    const operation = "getSummarySubtree";
    return this.core.read("summaries", operation, async (executor) => {
      const root = await findExactSummaryIdentity(
        executor,
        this.core,
        "summaries",
        operation,
        summaryId,
      );
      if (root === null) return [];
      const result = await executor.query<SummarySubtreeRow>({
        text: `WITH RECURSIVE reachable(summary_key) AS (
                 SELECT $3::pg_catalog.uuid
                 UNION
                 SELECT edge.summary_key
                 FROM lcm.summary_parents AS edge
                 INNER JOIN reachable AS parent
                   ON edge.parent_summary_key = parent.summary_key
                 WHERE edge.project_id = $1
                   AND edge.conversation_id = $2
               ),
               reachable_edges AS (
                 SELECT edge.summary_key, edge.parent_summary_key, edge.ordinal
                 FROM lcm.summary_parents AS edge
                 INNER JOIN reachable AS child
                   ON child.summary_key = edge.summary_key
                 INNER JOIN reachable AS parent
                   ON parent.summary_key = edge.parent_summary_key
                 WHERE edge.project_id = $1
                   AND edge.conversation_id = $2
               )
               SELECT s.summary_key, ${SUMMARY_SELECT},
                      edge.parent_summary_key AS edge_parent_summary_key,
                      edge.ordinal AS edge_ordinal
               FROM reachable
               INNER JOIN lcm.summaries AS s
                  ON s.project_id = $1
                  AND s.conversation_id = $2
                  AND s.summary_key = reachable.summary_key
               LEFT JOIN reachable_edges AS edge
                 ON edge.summary_key = s.summary_key
               ORDER BY s.summary_key, edge.ordinal, edge.parent_summary_key`,
        values: [this.projectId, root.conversationId, root.summaryKey],
      }, this.core.context("summaries", operation));

      const nodes = new Map<string, SummaryRecord>();
      const adjacency = new Map<string, Array<{
        readonly childKey: string;
        readonly ordinal: number;
      }>>();
      const edgeKeys = new Set<string>();
      for (const row of result.rows) {
        const summaryKey = text(
          row.summary_key,
          this.projectId,
          "summaries",
          operation,
          "summary_key",
        );
        const record = summaryFromRow(row, this.projectId, operation);
        const existing = nodes.get(summaryKey);
        if (existing !== undefined && existing.summaryId !== record.summaryId) {
          throw new PostgreSqlSummaryContextConflictError(
            this.projectId,
            "summaries",
            operation,
            "integrity",
          );
        }
        nodes.set(summaryKey, existing ?? record);

        if (
          row.edge_parent_summary_key === null
          && row.edge_ordinal === null
        ) continue;
        if (
          row.edge_parent_summary_key === null
          || row.edge_ordinal === null
        ) {
          throw new PostgreSqlSummaryContextDataError(
            this.projectId,
            "summaries",
            operation,
            "edge",
          );
        }
        const parentKey = text(
          row.edge_parent_summary_key,
          this.projectId,
          "summaries",
          operation,
          "edge_parent_summary_key",
        );
        const ordinal = safeInteger(
          row.edge_ordinal,
          this.projectId,
          "summaries",
          operation,
          "edge_ordinal",
        );
        if (ordinal < 0 || ordinal > MAX_POSTGRESQL_INTEGER) {
          throw new PostgreSqlSummaryContextDataError(
            this.projectId,
            "summaries",
            operation,
            "edge_ordinal",
          );
        }
        const edgeKey = `${parentKey}\0${summaryKey}`;
        if (edgeKeys.has(edgeKey)) {
          throw new PostgreSqlSummaryContextConflictError(
            this.projectId,
            "summaries",
            operation,
            "integrity",
          );
        }
        edgeKeys.add(edgeKey);
        const children = adjacency.get(parentKey) ?? [];
        children.push({ childKey: summaryKey, ordinal });
        adjacency.set(parentKey, children);
      }

      if (!nodes.has(root.summaryKey)) {
        throw new PostgreSqlSummaryContextConflictError(
          this.projectId,
          "summaries",
          operation,
          "integrity",
        );
      }
      for (const [parentKey, children] of adjacency) {
        if (!nodes.has(parentKey)) {
          throw new PostgreSqlSummaryContextConflictError(
            this.projectId,
            "summaries",
            operation,
            "integrity",
          );
        }
        children.sort((left, right) =>
          left.ordinal - right.ordinal
          || compareText(left.childKey, right.childKey));
      }

      type Traversal = {
        readonly key: string;
        readonly depthFromRoot: number;
        readonly parentKey: string | null;
        readonly path: string;
      };
      const compareTraversal = (left: Traversal, right: Traversal): number => {
        const pathOrder = compareText(left.path, right.path);
        if (pathOrder !== 0) return pathOrder;
        const leftNode = nodes.get(left.key)!;
        const rightNode = nodes.get(right.key)!;
        return leftNode.createdAt.getTime() - rightNode.createdAt.getTime()
          || compareText(left.key, right.key);
      };
      const visited = new Set<string>();
      const output: SummarySubtreeNodeRecord[] = [];
      let current = new Map<string, Traversal>([[
        root.summaryKey,
        {
          key: root.summaryKey,
          depthFromRoot: 0,
          parentKey: null,
          path: "",
        },
      ]]);
      while (current.size > 0) {
        const next = new Map<string, Traversal>();
        for (const entry of [...current.values()].sort(compareTraversal)) {
          if (visited.has(entry.key)) continue;
          const node = nodes.get(entry.key)!;
          visited.add(entry.key);
          output.push({
            ...node,
            depthFromRoot: entry.depthFromRoot,
            parentSummaryId: entry.parentKey === null
              ? null
              : nodes.get(entry.parentKey)!.summaryId,
            path: entry.path,
            childCount: adjacency.get(entry.key)?.length ?? 0,
          });
          for (const edge of adjacency.get(entry.key) ?? []) {
            if (visited.has(edge.childKey)) continue;
            const ordinalText = edge.ordinal.toString();
            const segment = ordinalText.padStart(
              POSTGRESQL_INTEGER_PATH_WIDTH,
              "0",
            );
            const candidate: Traversal = {
              key: edge.childKey,
              depthFromRoot: entry.depthFromRoot + 1,
              parentKey: entry.key,
              path: entry.path === ""
                ? segment
                : `${entry.path}.${segment}`,
            };
            const prior = next.get(edge.childKey);
            const pathOrder = prior === undefined
              ? 0
              : compareText(candidate.path, prior.path);
            if (
              prior === undefined
              || pathOrder < 0
              || (
                pathOrder === 0
                && candidate.parentKey! < prior.parentKey!
              )
            ) next.set(edge.childKey, candidate);
          }
        }
        current = next;
      }
      if (visited.size !== nodes.size) {
        throw new PostgreSqlSummaryContextConflictError(
          this.projectId,
          "summaries",
          operation,
          "integrity",
        );
      }
      return output;
    });
  }

  private async list(
    operation: string,
    predicate: string,
    values: unknown[],
    order: string,
    suffix = "",
  ): Promise<SummaryRecord[]> {
    return this.core.read("summaries", operation, async (executor) => {
      const result = await executor.query<SummaryRow>({
        text: `SELECT ${SUMMARY_SELECT}
               FROM lcm.summaries AS s
               WHERE s.project_id = $1
                 AND ${predicate}
               ORDER BY ${order}
               ${suffix}`,
        values,
      }, this.core.context("summaries", operation));
      return result.rows.map((row) =>
        summaryFromRow(row, this.projectId, operation));
    });
  }

  private async relatedSummaries(
    operation: string,
    summaryId: string,
    edgePredicate: string,
    summaryJoin: string,
  ): Promise<SummaryRecord[]> {
    return this.core.read("summaries", operation, async (executor) => {
      const identity = await findExactSummaryIdentity(
        executor,
        this.core,
        "summaries",
        operation,
        summaryId,
      );
      if (identity === null) return [];
      const result = await executor.query<SummaryRow>({
        text: `SELECT ${SUMMARY_SELECT}
               FROM lcm.summary_parents AS edge
               INNER JOIN lcm.summaries AS s
                 ON s.project_id = edge.project_id
                 AND s.conversation_id = edge.conversation_id
                 AND ${summaryJoin}
               WHERE edge.project_id = $1
                 AND edge.conversation_id = $2
                 AND ${edgePredicate}
               ORDER BY edge.ordinal, s.created_at, s.summary_key`,
        values: [
          this.projectId,
          identity.conversationId,
          identity.summaryKey,
        ],
      }, this.core.context("summaries", operation));
      return result.rows.map((row) =>
        summaryFromRow(row, this.projectId, operation));
    });
  }

  private validateSummaryInput(
    input: CreateSummaryInput,
    operation: string,
  ): void {
    if (input.kind !== "leaf" && input.kind !== "condensed") {
      throw new PostgreSqlSummaryContextDataError(
        this.projectId,
        "summaries",
        operation,
        "kind",
      );
    }
    validateOpaqueText(input.summaryId, this.projectId, "summaries", operation, "summary_id");
    validateOpaqueText(input.content, this.projectId, "summaries", operation, "content");
    safeNonnegativeInput(
      input.conversationId,
      this.projectId,
      "summaries",
      operation,
      "conversation_id",
    );
    safeNonnegativeInput(
      input.tokenCount,
      this.projectId,
      "summaries",
      operation,
      "token_count",
    );
    for (const [field, metric, maximum] of [
      ["depth", input.depth, MAX_POSTGRESQL_INTEGER],
      ["descendant_count", input.descendantCount, Number.MAX_SAFE_INTEGER],
      [
        "descendant_token_count",
        input.descendantTokenCount,
        Number.MAX_SAFE_INTEGER,
      ],
      [
        "source_message_token_count",
        input.sourceMessageTokenCount,
        Number.MAX_SAFE_INTEGER,
      ],
    ] as const) {
      if (
        typeof metric === "number"
        && Number.isFinite(metric)
        && metric >= 0
        && (
          !Number.isSafeInteger(Math.floor(metric))
          || Math.floor(metric) > maximum
        )
      ) {
        throw new PostgreSqlSummaryContextDataError(
          this.projectId,
          "summaries",
          operation,
          field,
        );
      }
    }
    for (const fileId of input.fileIds ?? []) {
      validateOpaqueText(fileId, this.projectId, "summaries", operation, "file_id");
    }
    for (const [field, timestamp] of [
      ["earliest_at", input.earliestAt],
      ["latest_at", input.latestAt],
    ] as const) {
      if (
        timestamp !== undefined
        && (
          !(timestamp instanceof Date)
          || !Number.isFinite(timestamp.getTime())
        )
      ) {
        throw new PostgreSqlSummaryContextDataError(
          this.projectId,
          "summaries",
          operation,
          field,
        );
      }
    }
    if (
      input.earliestAt !== undefined
      && input.latestAt !== undefined
      && input.earliestAt.getTime() > input.latestAt.getTime()
    ) {
      throw new PostgreSqlSummaryContextDataError(
        this.projectId,
        "summaries",
        operation,
        "summary_range",
      );
    }
  }
}

export class PostgreSqlContextRepository implements ContextRepository {
  private readonly core: RepositoryCore;

  constructor(
    executor: RepositoryExecutor,
    readonly projectId: string,
    options: PostgreSqlSummaryContextRepositoryOptions = {},
  ) {
    this.core = new RepositoryCore(executor, projectId, options);
  }

  async getContextItems(
    conversationId: number,
  ): Promise<ContextItemRecord[]> {
    const operation = "getContextItems";
    safeNonnegativeInput(
      conversationId,
      this.projectId,
      "context",
      operation,
      "conversation_id",
    );
    return this.core.read("context", operation, async (executor) => {
      const result = await executor.query<ContextItemRow>({
        text: `SELECT item.conversation_id, item.ordinal, item.item_type,
                      item.message_id, summary.summary_id, item.created_at
               FROM lcm.context_items AS item
               LEFT JOIN lcm.summaries AS summary
                 ON summary.project_id = item.project_id
                 AND summary.conversation_id = item.conversation_id
                 AND summary.summary_key = item.summary_key
               WHERE item.project_id = $1
                 AND item.conversation_id = $2
               ORDER BY item.ordinal`,
        values: [this.projectId, conversationId],
      }, this.core.context("context", operation));
      return result.rows.map((row) =>
        contextItemFromRow(row, this.projectId, operation));
    });
  }

  async getDistinctDepthsInContext(
    conversationId: number,
    options?: { maxOrdinalExclusive?: number },
  ): Promise<number[]> {
    const operation = "getDistinctDepthsInContext";
    safeNonnegativeInput(
      conversationId,
      this.projectId,
      "context",
      operation,
      "conversation_id",
    );
    const bound = options?.maxOrdinalExclusive;
    const useBound = typeof bound === "number"
      && Number.isFinite(bound);
    const normalizedBound = useBound
      ? BigInt(Math.floor(bound as number)).toString()
      : undefined;
    return this.core.read("context", operation, async (executor) => {
      const result = await executor.query<{ depth: unknown }>({
        text: `SELECT DISTINCT summary.depth
               FROM lcm.context_items AS item
               INNER JOIN lcm.summaries AS summary
                 ON summary.project_id = item.project_id
                 AND summary.conversation_id = item.conversation_id
                 AND summary.summary_key = item.summary_key
               WHERE item.project_id = $1
                 AND item.conversation_id = $2
                 AND item.item_type = 'summary'
                  ${useBound
                    ? "AND item.ordinal::pg_catalog.numeric < $3::pg_catalog.numeric"
                    : ""}
               ORDER BY summary.depth`,
        values: [
          this.projectId,
          conversationId,
          ...(useBound ? [normalizedBound] : []),
        ],
      }, this.core.context("context", operation));
      return result.rows.map((row) =>
        safeInteger(
          row.depth,
          this.projectId,
          "context",
          operation,
          "depth",
        ));
    });
  }

  async appendContextMessage(
    conversationId: number,
    messageId: number,
  ): Promise<void> {
    return this.appendMessages(
      "appendContextMessage",
      conversationId,
      [messageId],
    );
  }

  async appendContextMessages(
    conversationId: number,
    messageIds: number[],
  ): Promise<void> {
    return this.appendMessages(
      "appendContextMessages",
      conversationId,
      [...messageIds],
    );
  }

  private async appendMessages(
    operation: "appendContextMessage" | "appendContextMessages",
    conversationId: number,
    messageIds: number[],
  ): Promise<void> {
    if (messageIds.length === 0) return;
    for (const messageId of messageIds) {
      safeNonnegativeInput(
        messageId,
        this.projectId,
        "context",
        operation,
        "message_id",
      );
    }
    rejectDuplicateValues(messageIds, this.projectId, "context", operation);
    await this.core.mutation(
      "context",
      operation,
      conversationId,
      async (transaction) => {
        await this.assertConversation(transaction, conversationId, operation);
        const maximum = await transaction.query<{ max_ordinal: unknown }>({
          text: `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
                 FROM lcm.context_items
                 WHERE project_id = $1
                   AND conversation_id = $2`,
          values: [this.projectId, conversationId],
        }, this.core.context("context", operation));
        const base = safeInteger(
          maximum.rows[0]?.max_ordinal ?? -1,
          this.projectId,
          "context",
          operation,
          "max_ordinal",
        ) + 1;
        if (
          !Number.isSafeInteger(base)
          || base > MAX_POSTGRESQL_INTEGER
          || messageIds.length - 1 > MAX_POSTGRESQL_INTEGER - base
        ) {
          throw new PostgreSqlSummaryContextDataError(
            this.projectId,
            "context",
            operation,
            "ordinal",
          );
        }
        const inserted = await transaction.query({
          text: `WITH input AS (
                   SELECT message.message_id,
                          $3::pg_catalog.int8 + message.input_ordinal - 1
                            AS ordinal
                   FROM pg_catalog.jsonb_array_elements_text(
                     $4::pg_catalog.jsonb
                   ) WITH ORDINALITY AS message(message_id, input_ordinal)
                 )
                 INSERT INTO lcm.context_items (
                   project_id, conversation_id, ordinal, item_type, message_id
                 )
                 SELECT $1, $2, input.ordinal, 'message', stored.message_id
                 FROM input
                 INNER JOIN lcm.messages AS stored
                   ON stored.project_id = $1
                   AND stored.conversation_id = $2
                   AND stored.message_id =
                     input.message_id::pg_catalog.int8
                 ORDER BY input.ordinal
                 RETURNING message_id`,
          values: [
            this.projectId,
            conversationId,
            base,
            JSON.stringify(messageIds),
          ],
        }, this.core.context("context", operation));
        if (inserted.rows.length !== messageIds.length) {
          throw new PostgreSqlSummaryContextNotFoundError(
            this.projectId,
            "context",
            operation,
            "message",
          );
        }
      },
    );
  }

  async appendContextSummary(
    conversationId: number,
    summaryId: string,
  ): Promise<void> {
    const operation = "appendContextSummary";
    validateOpaqueText(
      summaryId,
      this.projectId,
      "context",
      operation,
      "summary_id",
    );
    await this.core.mutation(
      "context",
      operation,
      conversationId,
      async (transaction) => {
        await this.assertConversation(transaction, conversationId, operation);
        const summary = await exactSummaryIdentity(
          transaction,
          this.core,
          "context",
          operation,
          summaryId,
        );
        if (summary.conversationId !== conversationId) {
          throw new PostgreSqlSummaryContextConflictError(
            this.projectId,
            "context",
            operation,
            "cross-conversation",
          );
        }
        const maximum = await transaction.query<{ max_ordinal: unknown }>({
          text: `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
                 FROM lcm.context_items
                 WHERE project_id = $1
                   AND conversation_id = $2`,
          values: [this.projectId, conversationId],
        }, this.core.context("context", operation));
        const ordinal = safeInteger(
          maximum.rows[0]?.max_ordinal ?? -1,
          this.projectId,
          "context",
          operation,
          "max_ordinal",
        ) + 1;
        if (
          !Number.isSafeInteger(ordinal)
          || ordinal > MAX_POSTGRESQL_INTEGER
        ) {
          throw new PostgreSqlSummaryContextDataError(
            this.projectId,
            "context",
            operation,
            "ordinal",
          );
        }
        await transaction.query({
          text: `INSERT INTO lcm.context_items (
                   project_id, conversation_id, ordinal, item_type, summary_key
                 )
                 VALUES ($1, $2, $3, 'summary', $4)`,
          values: [
            this.projectId,
            conversationId,
            ordinal,
            summary.summaryKey,
          ],
        }, this.core.context("context", operation));
      },
    );
  }

  async replaceContextRangeWithSummary(input: {
    conversationId: number;
    startOrdinal: number;
    endOrdinal: number;
    summaryId: string;
  }): Promise<void> {
    const operation = "replaceContextRangeWithSummary";
    const snapshot = {
      conversationId: input.conversationId,
      startOrdinal: input.startOrdinal,
      endOrdinal: input.endOrdinal,
      summaryId: input.summaryId,
    };
    validateOpaqueText(
      snapshot.summaryId,
      this.projectId,
      "context",
      operation,
      "summary_id",
    );
    safeOrdinalInput(
      snapshot.startOrdinal,
      this.projectId,
      operation,
      "start_ordinal",
    );
    safeOrdinalInput(
      snapshot.endOrdinal,
      this.projectId,
      operation,
      "end_ordinal",
    );
    if (snapshot.startOrdinal > snapshot.endOrdinal) {
      throw new PostgreSqlSummaryContextConflictError(
        this.projectId,
        "context",
        operation,
        "range",
      );
    }
    await this.core.mutation(
      "context",
      operation,
      snapshot.conversationId,
      async (transaction) => {
        await this.assertConversation(
          transaction,
          snapshot.conversationId,
          operation,
        );
        const summary = await exactSummaryIdentity(
          transaction,
          this.core,
          "context",
          operation,
          snapshot.summaryId,
        );
        if (summary.conversationId !== snapshot.conversationId) {
          throw new PostgreSqlSummaryContextConflictError(
            this.projectId,
            "context",
            operation,
            "cross-conversation",
          );
        }
        const covered = await transaction.query<ContextRangeRow>({
          text: `SELECT COUNT(*) AS total_count,
                        COUNT(*) FILTER (
                          WHERE ordinal >= $3 AND ordinal <= $4
                        ) AS range_count,
                        COALESCE(MIN(ordinal), -1) AS min_ordinal,
                        COALESCE(MAX(ordinal), -1) AS max_ordinal
                 FROM lcm.context_items
                 WHERE project_id = $1
                   AND conversation_id = $2`,
          values: [
            this.projectId,
            snapshot.conversationId,
            snapshot.startOrdinal,
            snapshot.endOrdinal,
          ],
        }, this.core.context("context", operation));
        const range = covered.rows[0];
        const totalCount = safeInteger(
          range?.total_count ?? 0,
          this.projectId,
          "context",
          operation,
          "total_count",
        );
        const minimum = safeInteger(
          range?.min_ordinal ?? -1,
          this.projectId,
          "context",
          operation,
          "min_ordinal",
        );
        const maximum = safeInteger(
          range?.max_ordinal ?? -1,
          this.projectId,
          "context",
          operation,
          "max_ordinal",
        );
        const expected = snapshot.endOrdinal - snapshot.startOrdinal + 1;
        if (
          safeInteger(
            range?.range_count ?? 0,
            this.projectId,
            "context",
            operation,
            "range_count",
          ) !== expected
          || minimum !== 0
          || maximum !== totalCount - 1
        ) {
          throw new PostgreSqlSummaryContextConflictError(
            this.projectId,
            "context",
            operation,
            "range",
          );
        }
        await transaction.query({
          text: `DELETE FROM lcm.context_items
                 WHERE project_id = $1
                   AND conversation_id = $2
                   AND ordinal >= $3
                   AND ordinal <= $4`,
          values: [
            this.projectId,
            snapshot.conversationId,
            snapshot.startOrdinal,
            snapshot.endOrdinal,
          ],
        }, this.core.context("context", operation));
        const shift = snapshot.endOrdinal - snapshot.startOrdinal;
        if (shift > 0) {
          // PostgreSQL checks this non-deferrable unique index immediately.
          // Ascending single-row moves ensure each target ordinal is vacant;
          // one set UPDATE cannot guarantee a safe row visitation order.
          const suffix = await transaction.query<{ ordinal: unknown }>({
            text: `SELECT ordinal
                   FROM lcm.context_items
                   WHERE project_id = $1
                     AND conversation_id = $2
                     AND ordinal > $3
                   ORDER BY ordinal`,
            values: [
              this.projectId,
              snapshot.conversationId,
              snapshot.endOrdinal,
            ],
          }, this.core.context("context", operation));
          for (const row of suffix.rows) {
            const oldOrdinal = safeInteger(
              row.ordinal,
              this.projectId,
              "context",
              operation,
              "ordinal",
            );
            await transaction.query({
              text: `UPDATE lcm.context_items
                     SET ordinal = $3
                     WHERE project_id = $1
                       AND conversation_id = $2
                       AND ordinal = $4`,
              values: [
                this.projectId,
                snapshot.conversationId,
                oldOrdinal - shift,
                oldOrdinal,
              ],
            }, this.core.context("context", operation));
          }
        }
        await transaction.query({
          text: `INSERT INTO lcm.context_items (
                   project_id, conversation_id, ordinal, item_type, summary_key
                 )
                 VALUES ($1, $2, $3, 'summary', $4)`,
          values: [
            this.projectId,
            snapshot.conversationId,
            snapshot.startOrdinal,
            summary.summaryKey,
          ],
        }, this.core.context("context", operation));
      },
    );
  }

  async getContextTokenCount(conversationId: number): Promise<number> {
    const operation = "getContextTokenCount";
    safeNonnegativeInput(
      conversationId,
      this.projectId,
      "context",
      operation,
      "conversation_id",
    );
    return this.core.read("context", operation, async (executor) => {
      const result = await executor.query<{ total: unknown }>({
        text: `SELECT COALESCE(SUM(tokens.token_count), 0) AS total
               FROM (
                 SELECT message.token_count
                 FROM lcm.context_items AS item
                 INNER JOIN lcm.messages AS message
                   ON message.project_id = item.project_id
                   AND message.conversation_id = item.conversation_id
                   AND message.message_id = item.message_id
                 WHERE item.project_id = $1
                   AND item.conversation_id = $2
                   AND item.item_type = 'message'
                 UNION ALL
                 SELECT summary.token_count
                 FROM lcm.context_items AS item
                 INNER JOIN lcm.summaries AS summary
                   ON summary.project_id = item.project_id
                   AND summary.conversation_id = item.conversation_id
                   AND summary.summary_key = item.summary_key
                 WHERE item.project_id = $1
                   AND item.conversation_id = $2
                   AND item.item_type = 'summary'
               ) AS tokens`,
        values: [this.projectId, conversationId],
      }, this.core.context("context", operation));
      return safeInteger(
        result.rows[0]?.total ?? 0,
        this.projectId,
        "context",
        operation,
        "total",
      );
    });
  }

  private async assertConversation(
    executor: PostgreSqlQueryExecutor,
    conversationId: number,
    operation: string,
  ): Promise<void> {
    const result = await executor.query({
      text: `SELECT conversation_id
             FROM lcm.conversations
             WHERE project_id = $1
               AND conversation_id = $2`,
      values: [this.projectId, conversationId],
    }, this.core.context("context", operation));
    if (result.rows.length !== 1) {
      throw new PostgreSqlSummaryContextNotFoundError(
        this.projectId,
        "context",
        operation,
        "conversation",
      );
    }
  }
}

export class PostgreSqlLargeFileRepository implements LargeFileRepository {
  private readonly core: RepositoryCore;

  constructor(
    executor: RepositoryExecutor,
    readonly projectId: string,
    options: PostgreSqlSummaryContextRepositoryOptions = {},
  ) {
    this.core = new RepositoryCore(executor, projectId, options);
  }

  async insertLargeFile(
    input: CreateLargeFileInput,
  ): Promise<LargeFileRecord> {
    const operation = "insertLargeFile";
    const snapshot: CreateLargeFileInput = {
      fileId: input.fileId,
      conversationId: input.conversationId,
      ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
      ...(input.byteSize === undefined ? {} : { byteSize: input.byteSize }),
      storageUri: input.storageUri,
      ...(input.explorationSummary === undefined
        ? {}
        : { explorationSummary: input.explorationSummary }),
    };
    this.validateInput(snapshot, operation);
    return this.core.atomic("large-files", operation, async (transaction) => {
      const result = await transaction.query<LargeFileRow>({
        text: `INSERT INTO lcm.large_files (
                 file_id, project_id, conversation_id, file_name, mime_type,
                 byte_size, storage_uri, exploration_summary
               )
               SELECT $2, $1, conversation.conversation_id, $4, $5, $6, $7, $8
               FROM lcm.conversations AS conversation
               WHERE conversation.project_id = $1
                 AND conversation.conversation_id = $3
               RETURNING ${LARGE_FILE_COLUMNS}`,
        values: [
          this.projectId,
          snapshot.fileId,
          snapshot.conversationId,
          snapshot.fileName ?? null,
          snapshot.mimeType ?? null,
          snapshot.byteSize ?? null,
          snapshot.storageUri,
          snapshot.explorationSummary ?? null,
        ],
      }, this.core.context("large-files", operation));
      const row = result.rows[0];
      if (!row) {
        throw new PostgreSqlSummaryContextNotFoundError(
          this.projectId,
          "large-files",
          operation,
          "conversation",
        );
      }
      return largeFileFromRow(row, this.projectId, operation);
    });
  }

  async getLargeFile(fileId: string): Promise<LargeFileRecord | null> {
    const operation = "getLargeFile";
    validateOpaqueText(fileId, this.projectId, "large-files", operation, "file_id");
    return this.core.read("large-files", operation, async (executor) => {
      const result = await executor.query<LargeFileRow>({
        text: `SELECT ${LARGE_FILE_COLUMNS}
               FROM lcm.large_files
               WHERE project_id = $1
                 AND file_id_sha256 = public.digest($2, 'sha256')
                 AND file_id = $2
               ORDER BY file_key
               LIMIT 2`,
        values: [this.projectId, fileId],
      }, this.core.context("large-files", operation));
      if (result.rows.length > 1) {
        throw new PostgreSqlSummaryContextConflictError(
          this.projectId,
          "large-files",
          operation,
          "integrity",
        );
      }
      return result.rows[0]
        ? largeFileFromRow(result.rows[0], this.projectId, operation)
        : null;
    });
  }

  async getLargeFilesByConversation(
    conversationId: number,
  ): Promise<LargeFileRecord[]> {
    const operation = "getLargeFilesByConversation";
    safeNonnegativeInput(
      conversationId,
      this.projectId,
      "large-files",
      operation,
      "conversation_id",
    );
    return this.core.read("large-files", operation, async (executor) => {
      const result = await executor.query<LargeFileRow>({
        text: `SELECT ${LARGE_FILE_COLUMNS}
               FROM lcm.large_files
               WHERE project_id = $1
                 AND conversation_id = $2
               ORDER BY created_at, file_key`,
        values: [this.projectId, conversationId],
      }, this.core.context("large-files", operation));
      return result.rows.map((row) =>
        largeFileFromRow(row, this.projectId, operation));
    });
  }

  private validateInput(
    input: CreateLargeFileInput,
    operation: string,
  ): void {
    validateOpaqueText(input.fileId, this.projectId, "large-files", operation, "file_id");
    validateOpaqueText(
      input.fileName,
      this.projectId,
      "large-files",
      operation,
      "file_name",
      true,
    );
    validateOpaqueText(
      input.mimeType,
      this.projectId,
      "large-files",
      operation,
      "mime_type",
      true,
    );
    validateOpaqueText(input.storageUri, this.projectId, "large-files", operation, "storage_uri");
    validateOpaqueText(
      input.explorationSummary,
      this.projectId,
      "large-files",
      operation,
      "exploration_summary",
      true,
    );
    safeNonnegativeInput(
      input.conversationId,
      this.projectId,
      "large-files",
      operation,
      "conversation_id",
    );
    if (input.byteSize !== undefined) {
      safeNonnegativeInput(
        input.byteSize,
        this.projectId,
        "large-files",
        operation,
        "byte_size",
      );
    }
    if (input.storageUri.trim() === "") {
      throw new PostgreSqlSummaryContextDataError(
        this.projectId,
        "large-files",
        operation,
        "storage_uri",
      );
    }
  }
}
