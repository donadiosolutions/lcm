import type { QueryResultRow } from "pg";
import {
  normalizePromotedMetadata,
  serializePromotedMetadata,
} from "../../db/promoted.js";
import type {
  CoordinationRepository,
  JsonObject,
  PromotedMemoryRecord,
  PromotedMemoryRepository,
  RecallRepository,
  RedactionAdminRepository,
  RedactionCounts,
  RedactionPurgeResult,
  SessionIngestRecord,
  SessionInstructionsRecord,
  StorageDomain,
} from "../contracts.js";
import type { RecallFeedback, RecallStats } from "../../db/recall.js";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlOperationContext,
  PostgreSqlQueryExecutor,
  PostgreSqlTransactionScopeExecutor,
} from "./contracts.js";

const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type RepositoryDomain =
  | "promoted-memory"
  | "recall"
  | "redaction-admin"
  | "coordination";

type RepositoryContext = PostgreSqlOperationContext & {
  readonly domain: RepositoryDomain;
  readonly projectId: string;
};

export interface PostgreSqlMemoryExecutor extends PostgreSqlQueryExecutor {
  transaction<T>(
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: RepositoryContext,
  ): Promise<T>;
}

export interface PostgreSqlMemoryScopedExecutor
  extends PostgreSqlTransactionScopeExecutor {}

type RepositoryExecutor =
  | PostgreSqlMemoryExecutor
  | PostgreSqlMemoryScopedExecutor;

type ScopedExecutorState = { tail: Promise<void> };
const scopedExecutorStates = new WeakMap<
  PostgreSqlMemoryScopedExecutor,
  ScopedExecutorState
>();

type MemoryRow = QueryResultRow & {
  memory_id: unknown;
  content: unknown;
  tags: unknown;
  metadata: unknown;
  source_summary_id: unknown;
  source_project_id: unknown;
  session_id: unknown;
  depth: unknown;
  confidence: unknown;
  created_at: unknown;
  archived_at: unknown;
};

type StaleMemoryRow = MemoryRow & {
  surfacing_count: unknown;
  usage_count: unknown;
  days_since_created: unknown;
};

type FeedbackRow = QueryResultRow & {
  memory_id: unknown;
  usage_count: unknown;
  surfacing_count: unknown;
  last_surfaced_at: unknown;
};

type RecallStatsRow = QueryResultRow & {
  memories_surfaced: unknown;
  memories_acted_upon: unknown;
  top_recalled: unknown;
};

type RedactionCountsRow = QueryResultRow & {
  gitleaks: unknown;
  built_in: unknown;
  global: unknown;
  project: unknown;
};

type PurgeRow = QueryResultRow & {
  promoted_memories: unknown;
  promoted_tags: unknown;
  recall_surfacings: unknown;
  redaction_counters: unknown;
  session_ingest_logs: unknown;
  session_instructions: unknown;
};

type SessionIngestRow = QueryResultRow & {
  ingest_key: unknown;
  session_id: unknown;
  message_count: unknown;
  completed_at: unknown;
};

type SessionInstructionsRow = QueryResultRow & {
  slot: unknown;
  content: unknown;
  content_hash: unknown;
  updated_at: unknown;
};

type IsolationRow = QueryResultRow & {
  transaction_isolation: unknown;
};

const MEMORY_COLUMNS = `
  memory.memory_id,
  memory.content,
  COALESCE(
    (
      SELECT pg_catalog.jsonb_agg(tag.tag ORDER BY tag.ordinal)
      FROM lcm.promoted_memory_tags AS tag
      WHERE tag.project_id = memory.project_id
        AND tag.memory_id = memory.memory_id
    ),
    '[]'::pg_catalog.jsonb
  ) AS tags,
  memory.metadata,
  memory.source_summary_id,
  memory.source_project_id,
  memory.session_id,
  memory.depth,
  memory.confidence,
  memory.created_at,
  memory.archived_at
`.trim();

export class PostgreSqlMemoryDataError extends StorageOperationError {
  constructor(
    projectId: string,
    domain: RepositoryDomain,
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
    this.name = "PostgreSqlMemoryDataError";
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), field: this.field };
  }
}

function dataError(
  projectId: string,
  domain: RepositoryDomain,
  operation: string,
  field: string,
): never {
  throw new PostgreSqlMemoryDataError(projectId, domain, operation, field);
}

function safeInteger(
  value: unknown,
  projectId: string,
  domain: RepositoryDomain,
  operation: string,
  field: string,
): number {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return value;
    return dataError(projectId, domain, operation, field);
  }
  if (
    typeof value !== "bigint"
    && (typeof value !== "string" || !/^-?\d+$/u.test(value))
  ) {
    return dataError(projectId, domain, operation, field);
  }
  const candidate = typeof value === "bigint" ? value : BigInt(value);
  if (candidate < MIN_SAFE_BIGINT || candidate > MAX_SAFE_BIGINT) {
    return dataError(projectId, domain, operation, field);
  }
  return Number(candidate);
}

function nonnegativeInteger(
  value: unknown,
  projectId: string,
  domain: RepositoryDomain,
  operation: string,
  field: string,
): number {
  const candidate = safeInteger(
    value,
    projectId,
    domain,
    operation,
    field,
  );
  return candidate < 0
    ? dataError(projectId, domain, operation, field)
    : candidate;
}

function finiteNumber(
  value: unknown,
  projectId: string,
  domain: RepositoryDomain,
  operation: string,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return dataError(projectId, domain, operation, field);
  }
  return value;
}

function string(
  value: unknown,
  projectId: string,
  domain: RepositoryDomain,
  operation: string,
  field: string,
): string {
  if (typeof value !== "string") {
    return dataError(projectId, domain, operation, field);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) return dataError(projectId, domain, operation, field);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        return dataError(projectId, domain, operation, field);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return dataError(projectId, domain, operation, field);
    }
  }
  return value;
}

function uuid(
  value: unknown,
  projectId: string,
  domain: RepositoryDomain,
  operation: string,
  field: string,
): string {
  const candidate = string(
    value,
    projectId,
    domain,
    operation,
    field,
  );
  if (!UUID_PATTERN.test(candidate)) {
    return dataError(projectId, domain, operation, field);
  }
  return candidate.toLowerCase();
}

function uuidV7(
  value: unknown,
  projectId: string,
  domain: RepositoryDomain,
  operation: string,
  field: string,
): string {
  const candidate = uuid(
    value,
    projectId,
    domain,
    operation,
    field,
  );
  if (!UUIDV7_PATTERN.test(candidate)) {
    return dataError(projectId, domain, operation, field);
  }
  return candidate;
}

function optionalMemoryUuid(
  value: unknown,
  projectId: string,
  operation: string,
): string | null {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return null;
  return uuid(
    value,
    projectId,
    "promoted-memory",
    operation,
    "memory_id",
  );
}

function timestamp(
  value: unknown,
  projectId: string,
  domain: RepositoryDomain,
  operation: string,
  field: string,
): string {
  const normalized = typeof value === "string"
    && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const candidate = value instanceof Date
    ? new Date(value.getTime())
    : typeof normalized === "string"
      ? new Date(normalized)
      : new Date(Number.NaN);
  if (!Number.isFinite(candidate.getTime())) {
    return dataError(projectId, domain, operation, field);
  }
  return candidate.toISOString();
}

function nullableString(
  value: unknown,
  projectId: string,
  domain: RepositoryDomain,
  operation: string,
  field: string,
): string | null {
  return value === null
    ? null
    : string(value, projectId, domain, operation, field);
}

function tags(
  value: unknown,
  projectId: string,
  operation: string,
): string[] {
  if (!Array.isArray(value)) {
    return dataError(
      projectId,
      "promoted-memory",
      operation,
      "tags",
    );
  }
  return value.map((tag) =>
    string(
      tag,
      projectId,
      "promoted-memory",
      operation,
      "tags",
    ));
}

function metadata(
  value: unknown,
  projectId: string,
  operation: string,
): JsonObject {
  try {
    return normalizePromotedMetadata(value);
  } catch {
    return dataError(
      projectId,
      "promoted-memory",
      operation,
      "metadata",
    );
  }
}

function memoryFromRow(
  row: MemoryRow,
  projectId: string,
  operation: string,
): PromotedMemoryRecord {
  return {
    id: uuid(
      row.memory_id,
      projectId,
      "promoted-memory",
      operation,
      "memory_id",
    ),
    content: string(
      row.content,
      projectId,
      "promoted-memory",
      operation,
      "content",
    ),
    tags: tags(row.tags, projectId, operation),
    metadata: metadata(row.metadata, projectId, operation),
    sourceSummaryId: nullableString(
      row.source_summary_id,
      projectId,
      "promoted-memory",
      operation,
      "source_summary_id",
    ),
    projectId: row.source_project_id === null
      ? projectId
      : string(
          row.source_project_id,
          projectId,
          "promoted-memory",
          operation,
          "source_project_id",
        ),
    sessionId: nullableString(
      row.session_id,
      projectId,
      "promoted-memory",
      operation,
      "session_id",
    ),
    depth: nonnegativeInteger(
      row.depth,
      projectId,
      "promoted-memory",
      operation,
      "depth",
    ),
    confidence: finiteNumber(
      row.confidence,
      projectId,
      "promoted-memory",
      operation,
      "confidence",
    ),
    createdAt: timestamp(
      row.created_at,
      projectId,
      "promoted-memory",
      operation,
      "created_at",
    ),
    archivedAt: row.archived_at === null
      ? null
      : timestamp(
          row.archived_at,
          projectId,
          "promoted-memory",
          operation,
          "archived_at",
        ),
  };
}

function jsonArray(value: readonly unknown[]): string {
  return JSON.stringify(value);
}

class RepositoryAccess {
  readonly projectId: string;

  constructor(
    private readonly executor: RepositoryExecutor,
    projectId: string,
    private readonly domain: RepositoryDomain,
  ) {
    this.projectId = uuidV7(
      projectId,
      projectId,
      domain,
      "construct",
      "project_id",
    );
  }

  context(operation: string): RepositoryContext {
    return {
      domain: this.domain,
      operation,
      projectId: this.projectId,
    };
  }

  read<T>(
    operation: string,
    callback: (executor: PostgreSqlQueryExecutor) => Promise<T>,
  ): Promise<T> {
    const root = this.rootExecutor();
    return root ? callback(root) : this.scopedSerialized(operation, callback);
  }

  atomic<T>(
    operation: string,
    callback: (executor: PostgreSqlQueryExecutor) => Promise<T>,
  ): Promise<T> {
    const root = this.rootExecutor();
    return root
      ? root.transaction(callback, this.context(operation))
      : this.scopedSerialized(operation, (executor) =>
          executor.savepoint(callback, this.context(operation)));
  }

  readCommittedAtomic<T>(
    operation: string,
    callback: (executor: PostgreSqlQueryExecutor) => Promise<T>,
  ): Promise<T> {
    const root = this.rootExecutor();
    return root
      ? root.transaction(async (transaction) => {
          await transaction.query({
            text: "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
          }, this.context(operation));
          return callback(transaction);
        }, this.context(operation))
      : this.scopedSerialized(operation, async (executor) => {
          const isolation = await executor.query<IsolationRow>({
            text: `SELECT pg_catalog.current_setting(
                            'transaction_isolation'
                          ) AS transaction_isolation`,
          }, this.context(operation));
          if (
            typeof isolation.rows[0]?.transaction_isolation !== "string"
            || isolation.rows[0].transaction_isolation.trim().toLowerCase()
              !== "read committed"
          ) {
            return dataError(
              this.projectId,
              this.domain,
              operation,
              "transaction_isolation",
            );
          }
          return executor.savepoint(callback, this.context(operation));
        });
  }

  private rootExecutor(): PostgreSqlMemoryExecutor | null {
    return "transaction" in this.executor
      && typeof this.executor.transaction === "function"
      ? this.executor
      : null;
  }

  private scopedSerialized<T>(
    operation: string,
    callback: (executor: PostgreSqlMemoryScopedExecutor) => Promise<T>,
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
        this.domain,
        operation,
      ));
    }
    const executor = this.executor as PostgreSqlMemoryScopedExecutor;
    const state = scopedExecutorStates.get(executor) ?? {
      tail: Promise.resolve(),
    };
    scopedExecutorStates.set(executor, state);
    const execute = state.tail.then(() => callback(executor));
    state.tail = execute.then(() => undefined, () => undefined);
    return execute;
  }
}

export class PostgreSqlPromotedMemoryRepository
implements PromotedMemoryRepository {
  private readonly access: RepositoryAccess;

  constructor(executor: RepositoryExecutor, projectId: string) {
    this.access = new RepositoryAccess(
      executor,
      projectId,
      "promoted-memory",
    );
  }

  async insert(
    input: Parameters<PromotedMemoryRepository["insert"]>[0],
  ): Promise<string> {
    const operation = "insert";
    const content = string(
      input.content,
      this.access.projectId,
      "promoted-memory",
      operation,
      "content",
    );
    if (content.length === 0) {
      return dataError(
        this.access.projectId,
        "promoted-memory",
        operation,
        "content",
      );
    }
    const inputTags = tags(input.tags ?? [], this.access.projectId, operation);
    const inputMetadata = metadata(
      input.metadata ?? {},
      this.access.projectId,
      operation,
    );
    const sourceSummaryId = input.sourceSummaryId === undefined
      ? null
      : string(
          input.sourceSummaryId,
          this.access.projectId,
          "promoted-memory",
          operation,
          "source_summary_id",
        );
    const sourceProjectId = input.sourceProjectId === undefined
      ? this.access.projectId
      : string(
          input.sourceProjectId,
          this.access.projectId,
          "promoted-memory",
          operation,
          "source_project_id",
        );
    const sessionId = input.sessionId === undefined
      ? null
      : string(
          input.sessionId,
          this.access.projectId,
          "promoted-memory",
          operation,
          "session_id",
        );
    const depth = nonnegativeInteger(
      input.depth ?? 0,
      this.access.projectId,
      "promoted-memory",
      operation,
      "depth",
    );
    const confidence = finiteNumber(
      input.confidence ?? 1,
      this.access.projectId,
      "promoted-memory",
      operation,
      "confidence",
    );
    if (confidence < 0 || confidence > 1) {
      return dataError(
        this.access.projectId,
        "promoted-memory",
        operation,
        "confidence",
      );
    }
    return this.access.atomic(operation, async (executor) => {
      const inserted = await executor.query<{ memory_id: unknown }>({
        text: `INSERT INTO lcm.promoted_memories (
                 project_id, content, source_summary_id, source_project_id,
                 session_id, depth, confidence, metadata
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8::pg_catalog.jsonb)
               RETURNING memory_id`,
        values: [
          this.access.projectId,
          content,
          sourceSummaryId,
          sourceProjectId,
          sessionId,
          depth,
          confidence,
          serializePromotedMetadata(inputMetadata),
        ],
      }, this.access.context(operation));
      const memoryId = uuid(
        inserted.rows[0]?.memory_id,
        this.access.projectId,
        "promoted-memory",
        operation,
        "memory_id",
      );
      if (inputTags.length > 0) {
        await this.insertTags(
          executor,
          memoryId,
          inputTags,
          operation,
        );
      }
      return memoryId;
    });
  }

  async getById(id: string): Promise<PromotedMemoryRecord | null> {
    const operation = "getById";
    const memoryId = optionalMemoryUuid(id, this.access.projectId, operation);
    if (memoryId === null) return null;
    return this.access.read(operation, async (executor) => {
      const result = await executor.query<MemoryRow>({
        text: `SELECT ${MEMORY_COLUMNS}
               FROM lcm.promoted_memories AS memory
               WHERE memory.project_id = $1
                 AND memory.memory_id = $2`,
        values: [this.access.projectId, memoryId],
      }, this.access.context(operation));
      const row = result.rows[0];
      return row
        ? memoryFromRow(row, this.access.projectId, operation)
        : null;
    });
  }

  async getAll(
    options: Parameters<PromotedMemoryRepository["getAll"]>[0] = {},
  ): Promise<PromotedMemoryRecord[]> {
    const operation = "getAll";
    const sourceProjectId = options.sourceProjectId === undefined
      ? null
      : string(
          options.sourceProjectId,
          this.access.projectId,
          "promoted-memory",
          operation,
          "source_project_id",
        );
    const since = options.since === undefined
      ? null
      : timestamp(
          options.since,
          this.access.projectId,
          "promoted-memory",
          operation,
          "since",
        );
    const filterTags = tags(
      options.tags ?? [],
      this.access.projectId,
      operation,
    );
    return this.access.read(operation, async (executor) => {
      const result = await executor.query<MemoryRow>({
        text: `SELECT ${MEMORY_COLUMNS}
               FROM lcm.promoted_memories AS memory
               WHERE memory.project_id = $1
                 AND memory.archived_at IS NULL
                 AND ($2::pg_catalog.text IS NULL
                      OR memory.source_project_id = $2)
                 AND ($3::pg_catalog.timestamptz IS NULL
                      OR memory.created_at >= $3)
                 AND NOT EXISTS (
                   SELECT 1
                   FROM pg_catalog.jsonb_array_elements_text(
                     $4::pg_catalog.jsonb
                   ) AS requested(tag)
                   WHERE NOT EXISTS (
                     SELECT 1
                     FROM lcm.promoted_memory_tags AS stored
                     WHERE stored.project_id = memory.project_id
                       AND stored.memory_id = memory.memory_id
                       AND stored.tag = requested.tag
                   )
                 )
               ORDER BY memory.created_at, memory.memory_id`,
        values: [
          this.access.projectId,
          sourceProjectId,
          since,
          jsonArray(filterTags),
        ],
      }, this.access.context(operation));
      return result.rows.map((row) =>
        memoryFromRow(row, this.access.projectId, operation));
    });
  }

  async listContentPrefixes(limit: number): Promise<string[]> {
    const operation = "listContentPrefixes";
    const normalizedLimit = safeInteger(
      limit,
      this.access.projectId,
      "promoted-memory",
      operation,
      "limit",
    );
    if (normalizedLimit === 0) return [];
    return this.access.read(operation, async (executor) => {
      const bounded = normalizedLimit < 0 ? null : normalizedLimit;
      const result = await executor.query<{ content: unknown }>({
        text: `SELECT content
               FROM lcm.promoted_memories
               WHERE project_id = $1
                 AND archived_at IS NULL
               ORDER BY created_at, memory_id
               LIMIT $2`,
        values: [this.access.projectId, bounded],
      }, this.access.context(operation));
      return result.rows.map((row) =>
        string(
          row.content,
          this.access.projectId,
          "promoted-memory",
          operation,
          "content",
        ));
    });
  }

  archive(id: string): Promise<void> {
    return this.updateArchiveState(id, "archive", false);
  }

  async deleteById(id: string): Promise<void> {
    const operation = "deleteById";
    const memoryId = optionalMemoryUuid(id, this.access.projectId, operation);
    if (memoryId === null) return;
    await this.access.atomic(operation, async (executor) => {
      await executor.query({
        text: `DELETE FROM lcm.promoted_memories
               WHERE project_id = $1
                 AND memory_id = $2`,
        values: [this.access.projectId, memoryId],
      }, this.access.context(operation));
    });
  }

  async update(
    id: string,
    fields: Parameters<PromotedMemoryRepository["update"]>[1],
  ): Promise<void> {
    const operation = "update";
    const memoryId = optionalMemoryUuid(id, this.access.projectId, operation);
    if (memoryId === null) return;
    const hasContent = fields.content !== undefined;
    const content = hasContent
      ? string(
          fields.content,
          this.access.projectId,
          "promoted-memory",
          operation,
          "content",
        )
      : "";
    if (hasContent && content.length === 0) {
      return dataError(
        this.access.projectId,
        "promoted-memory",
        operation,
        "content",
      );
    }
    const hasConfidence = fields.confidence !== undefined;
    const confidence = hasConfidence
      ? finiteNumber(
          fields.confidence,
          this.access.projectId,
          "promoted-memory",
          operation,
          "confidence",
        )
      : 0;
    if (hasConfidence && (confidence < 0 || confidence > 1)) {
      return dataError(
        this.access.projectId,
        "promoted-memory",
        operation,
        "confidence",
      );
    }
    const hasTags = fields.tags !== undefined;
    const inputTags = tags(
      fields.tags ?? [],
      this.access.projectId,
      operation,
    );
    const hasMetadata = fields.metadata !== undefined;
    const inputMetadata = metadata(
      fields.metadata ?? {},
      this.access.projectId,
      operation,
    );
    await this.access.atomic(operation, async (executor) => {
      const updated = await executor.query<{ memory_id: unknown }>({
        text: `UPDATE lcm.promoted_memories
               SET content = CASE WHEN $3 THEN $4 ELSE content END,
                   confidence = CASE WHEN $5 THEN $6 ELSE confidence END,
                   metadata = CASE
                     WHEN $7 THEN $8::pg_catalog.jsonb
                     ELSE metadata
                   END
               WHERE project_id = $1
                 AND memory_id = $2
               RETURNING memory_id`,
        values: [
          this.access.projectId,
          memoryId,
          hasContent,
          content,
          hasConfidence,
          confidence,
          hasMetadata,
          serializePromotedMetadata(inputMetadata),
        ],
      }, this.access.context(operation));
      if (updated.rows.length === 0 || !hasTags) return;
      await executor.query({
        text: `DELETE FROM lcm.promoted_memory_tags
               WHERE project_id = $1
                 AND memory_id = $2`,
        values: [this.access.projectId, memoryId],
      }, this.access.context(operation));
      if (inputTags.length > 0) {
        await this.insertTags(
          executor,
          memoryId,
          inputTags,
          operation,
        );
      }
    });
  }

  async findStale(
    options: Parameters<PromotedMemoryRepository["findStale"]>[0],
  ): Promise<Array<
    PromotedMemoryRecord & {
      surfacingCount: number;
      usageCount: number;
      daysSinceCreated: number;
    }
  >> {
    const operation = "findStale";
    const staleAfterDays = finiteNumber(
      options.staleAfterDays,
      this.access.projectId,
      "promoted-memory",
      operation,
      "stale_after_days",
    );
    const surfacingLimit = nonnegativeInteger(
      options.staleSurfacingWithoutUseLimit,
      this.access.projectId,
      "promoted-memory",
      operation,
      "stale_surfacing_without_use_limit",
    );
    const sourceProjectId = options.sourceProjectId === undefined
      ? null
      : string(
          options.sourceProjectId,
          this.access.projectId,
          "promoted-memory",
          operation,
          "source_project_id",
        );
    return this.access.read(operation, async (executor) => {
      const result = await executor.query<StaleMemoryRow>({
        text: `WITH usage_counts AS (
                 SELECT pg_catalog.substr(reference.tag, 11)
                          AS memory_id,
                        pg_catalog.count(*) AS usage_count
                 FROM lcm.promoted_memories AS signal
                 INNER JOIN lcm.promoted_memory_tags AS marker
                   ON marker.project_id = signal.project_id
                  AND marker.memory_id = signal.memory_id
                  AND marker.tag = 'signal:memory_used'
                 INNER JOIN LATERAL (
                   SELECT candidate.tag
                   FROM lcm.promoted_memory_tags AS candidate
                   WHERE candidate.project_id = signal.project_id
                     AND candidate.memory_id = signal.memory_id
                     AND pg_catalog.substr(candidate.tag, 1, 10)
                       = 'memory_id:'
                   ORDER BY candidate.ordinal
                   LIMIT 1
                 ) AS reference ON TRUE
                 WHERE signal.project_id = $1
                   AND signal.archived_at IS NULL
                 GROUP BY pg_catalog.substr(reference.tag, 11)
               ),
               candidates AS (
                 SELECT memory.*,
                        COALESCE(surfacing.surfacing_count, 0)
                          AS surfacing_count,
                        COALESCE(usage.usage_count, 0) AS usage_count,
                        pg_catalog.floor(
                          pg_catalog.date_part(
                            'epoch',
                            statement_timestamp() - memory.created_at
                          ) / 86400
                        )::pg_catalog.int8 AS days_since_created
                 FROM lcm.promoted_memories AS memory
                 LEFT JOIN LATERAL (
                   SELECT pg_catalog.count(*) AS surfacing_count
                   FROM lcm.recall_surfacing AS surfaced
                   WHERE surfaced.project_id = memory.project_id
                     AND surfaced.memory_id = memory.memory_id::pg_catalog.text
                 ) AS surfacing ON TRUE
                 LEFT JOIN usage_counts AS usage
                   ON usage.memory_id = memory.memory_id::pg_catalog.text
                 WHERE memory.project_id = $1
                   AND memory.archived_at IS NULL
                   AND memory.created_at
                     < statement_timestamp()
                       - (INTERVAL '1 day' * $2::pg_catalog.float8)
                   AND ($3::pg_catalog.text IS NULL
                        OR memory.source_project_id = $3)
               )
               SELECT ${MEMORY_COLUMNS},
                      memory.surfacing_count,
                      memory.usage_count,
                      memory.days_since_created
               FROM candidates AS memory
               WHERE (
                 memory.surfacing_count >= $4
                 AND memory.usage_count = 0
               ) OR (
                 memory.surfacing_count = 0
                 AND memory.usage_count = 0
               )
               ORDER BY memory.created_at, memory.memory_id`,
        values: [
          this.access.projectId,
          staleAfterDays,
          sourceProjectId,
          surfacingLimit,
        ],
      }, this.access.context(operation));
      return result.rows.map((row) => ({
        ...memoryFromRow(row, this.access.projectId, operation),
        surfacingCount: nonnegativeInteger(
          row.surfacing_count,
          this.access.projectId,
          "promoted-memory",
          operation,
          "surfacing_count",
        ),
        usageCount: nonnegativeInteger(
          row.usage_count,
          this.access.projectId,
          "promoted-memory",
          operation,
          "usage_count",
        ),
        daysSinceCreated: safeInteger(
          row.days_since_created,
          this.access.projectId,
          "promoted-memory",
          operation,
          "days_since_created",
        ),
      }));
    });
  }

  revive(id: string): Promise<void> {
    return this.updateArchiveState(id, "revive", true);
  }

  private async insertTags(
    executor: PostgreSqlQueryExecutor,
    memoryId: string,
    inputTags: readonly string[],
    operation: string,
  ): Promise<void> {
    await executor.query({
      text: `INSERT INTO lcm.promoted_memory_tags (
               project_id, memory_id, ordinal, tag
             )
             SELECT $1, $2,
                    (input.ordinality - 1)::pg_catalog.int4,
                    input.tag
             FROM pg_catalog.jsonb_array_elements_text(
               $3::pg_catalog.jsonb
             ) WITH ORDINALITY AS input(tag, ordinality)
             ORDER BY input.ordinality`,
      values: [
        this.access.projectId,
        memoryId,
        jsonArray(inputTags),
      ],
    }, this.access.context(operation));
  }

  private async updateArchiveState(
    id: string,
    operation: "archive" | "revive",
    active: boolean,
  ): Promise<void> {
    const memoryId = optionalMemoryUuid(id, this.access.projectId, operation);
    if (memoryId === null) return;
    await this.access.atomic(operation, async (executor) => {
      await executor.query({
        text: `UPDATE lcm.promoted_memories
               SET archived_at = CASE
                 WHEN $3 THEN NULL
                 ELSE GREATEST(statement_timestamp(), created_at)
               END
               WHERE project_id = $1
                 AND memory_id = $2`,
        values: [this.access.projectId, memoryId, active],
      }, this.access.context(operation));
    });
  }
}

export class PostgreSqlRecallRepository implements RecallRepository {
  private readonly access: RepositoryAccess;

  constructor(executor: RepositoryExecutor, projectId: string) {
    this.access = new RepositoryAccess(executor, projectId, "recall");
  }

  async logSurfacing(
    memoryIds: string[],
    sessionId: string | null,
  ): Promise<void> {
    const operation = "logSurfacing";
    const normalizedIds = Object.freeze(memoryIds.map((id) =>
      string(
        id,
        this.access.projectId,
        "recall",
        operation,
        "memory_id",
      )));
    const normalizedSessionId = sessionId === null
      ? null
      : string(
          sessionId,
          this.access.projectId,
          "recall",
          operation,
          "session_id",
        );
    if (normalizedIds.length === 0) return;
    await this.access.atomic(operation, async (executor) => {
      await executor.query({
        text: `INSERT INTO lcm.recall_surfacing (
                 project_id, memory_id, session_id
               )
               SELECT $1, input.memory_id, $2
               FROM pg_catalog.jsonb_array_elements_text(
                 $3::pg_catalog.jsonb
               ) WITH ORDINALITY AS input(memory_id, ordinality)
               ORDER BY input.ordinality`,
        values: [
          this.access.projectId,
          normalizedSessionId,
          jsonArray(normalizedIds),
        ],
      }, this.access.context(operation));
    });
  }

  async getFeedback(memoryIds: string[]): Promise<Map<string, RecallFeedback>> {
    const operation = "getFeedback";
    const normalizedIds = Object.freeze(memoryIds.map((id) =>
      string(
        id,
        this.access.projectId,
        "recall",
        operation,
        "memory_id",
      )));
    const feedback = new Map<string, RecallFeedback>(
      normalizedIds.map((id) => [
        id,
        { usageCount: 0, surfacingCount: 0, lastSurfacedAt: null },
      ]),
    );
    if (normalizedIds.length === 0) return feedback;
    return this.access.read(operation, async (executor) => {
      const result = await executor.query<FeedbackRow>({
        text: `WITH requested AS (
                 SELECT DISTINCT input.memory_id
                 FROM pg_catalog.jsonb_array_elements_text(
                   $2::pg_catalog.jsonb
                 ) AS input(memory_id)
               ),
               surfaced AS (
                 SELECT surfacing.memory_id,
                        pg_catalog.count(*) AS surfacing_count,
                        pg_catalog.max(surfacing.surfaced_at)
                          AS last_surfaced_at
                 FROM lcm.recall_surfacing AS surfacing
                 INNER JOIN requested
                   ON requested.memory_id = surfacing.memory_id
                 WHERE surfacing.project_id = $1
                 GROUP BY surfacing.memory_id
               ),
               used AS (
                 SELECT pg_catalog.substr(reference.tag, 11)
                          AS memory_id,
                        pg_catalog.count(*) AS usage_count
                 FROM lcm.promoted_memories AS signal
                 INNER JOIN lcm.promoted_memory_tags AS marker
                   ON marker.project_id = signal.project_id
                  AND marker.memory_id = signal.memory_id
                  AND marker.tag = 'signal:memory_used'
                 INNER JOIN LATERAL (
                   SELECT candidate.tag
                   FROM lcm.promoted_memory_tags AS candidate
                   WHERE candidate.project_id = signal.project_id
                     AND candidate.memory_id = signal.memory_id
                     AND pg_catalog.substr(candidate.tag, 1, 10)
                       = 'memory_id:'
                   ORDER BY candidate.ordinal
                   LIMIT 1
                 ) AS reference ON TRUE
                 INNER JOIN requested
                   ON requested.memory_id
                     = pg_catalog.substr(reference.tag, 11)
                 WHERE signal.project_id = $1
                   AND signal.archived_at IS NULL
                 GROUP BY pg_catalog.substr(reference.tag, 11)
               )
               SELECT requested.memory_id,
                      COALESCE(used.usage_count, 0) AS usage_count,
                      COALESCE(surfaced.surfacing_count, 0)
                        AS surfacing_count,
                      surfaced.last_surfaced_at
               FROM requested
               LEFT JOIN surfaced USING (memory_id)
               LEFT JOIN used USING (memory_id)`,
        values: [this.access.projectId, jsonArray(normalizedIds)],
      }, this.access.context(operation));
      for (const row of result.rows) {
        const memoryId = string(
          row.memory_id,
          this.access.projectId,
          "recall",
          operation,
          "memory_id",
        );
        if (!feedback.has(memoryId)) {
          return dataError(
            this.access.projectId,
            "recall",
            operation,
            "memory_id",
          );
        }
        feedback.set(memoryId, {
          usageCount: nonnegativeInteger(
            row.usage_count,
            this.access.projectId,
            "recall",
            operation,
            "usage_count",
          ),
          surfacingCount: nonnegativeInteger(
            row.surfacing_count,
            this.access.projectId,
            "recall",
            operation,
            "surfacing_count",
          ),
          lastSurfacedAt: row.last_surfaced_at === null
            ? null
            : timestamp(
                row.last_surfaced_at,
                this.access.projectId,
                "recall",
                operation,
                "last_surfaced_at",
              ),
        });
      }
      return feedback;
    });
  }

  async getStats(): Promise<RecallStats> {
    const operation = "getStats";
    return this.access.read(operation, async (executor) => {
      const result = await executor.query<RecallStatsRow>({
        text: `WITH usage_counts AS (
                 SELECT pg_catalog.substr(reference.tag, 11)
                          AS memory_id,
                        pg_catalog.count(*) AS act_count
                 FROM lcm.promoted_memories AS signal
                 INNER JOIN lcm.promoted_memory_tags AS marker
                   ON marker.project_id = signal.project_id
                  AND marker.memory_id = signal.memory_id
                  AND marker.tag = 'signal:memory_used'
                 INNER JOIN LATERAL (
                   SELECT candidate.tag
                   FROM lcm.promoted_memory_tags AS candidate
                   WHERE candidate.project_id = signal.project_id
                     AND candidate.memory_id = signal.memory_id
                     AND pg_catalog.substr(candidate.tag, 1, 10)
                       = 'memory_id:'
                   ORDER BY candidate.ordinal
                   LIMIT 1
                 ) AS reference ON TRUE
                 WHERE signal.project_id = $1
                   AND signal.archived_at IS NULL
                 GROUP BY pg_catalog.substr(reference.tag, 11)
               ),
               ranked AS (
                 SELECT usage.memory_id,
                        COALESCE(memory.content, '(memory not found)') AS content,
                        usage.act_count
                 FROM usage_counts AS usage
                 LEFT JOIN lcm.promoted_memories AS memory
                   ON memory.project_id = $1
                  AND memory.memory_id::pg_catalog.text = usage.memory_id
                 ORDER BY usage.act_count DESC, usage.memory_id
                 LIMIT 5
               )
               SELECT (
                        SELECT pg_catalog.count(DISTINCT surfacing.memory_id)
                        FROM lcm.recall_surfacing AS surfacing
                        WHERE surfacing.project_id = $1
                      ) AS memories_surfaced,
                      (SELECT pg_catalog.count(*) FROM usage_counts)
                        AS memories_acted_upon,
                      COALESCE(
                        (
                          SELECT pg_catalog.jsonb_agg(
                            pg_catalog.jsonb_build_object(
                              'id', ranked.memory_id,
                              'content', ranked.content,
                              'actCount', ranked.act_count::pg_catalog.text
                            )
                            ORDER BY ranked.act_count DESC, ranked.memory_id
                          )
                          FROM ranked
                        ),
                        '[]'::pg_catalog.jsonb
                      ) AS top_recalled`,
        values: [this.access.projectId],
      }, this.access.context(operation));
      const row = result.rows[0];
      if (!row) {
        return dataError(
          this.access.projectId,
          "recall",
          operation,
          "stats",
        );
      }
      const memoriesSurfaced = nonnegativeInteger(
        row.memories_surfaced,
        this.access.projectId,
        "recall",
        operation,
        "memories_surfaced",
      );
      const memoriesActedUpon = nonnegativeInteger(
        row.memories_acted_upon,
        this.access.projectId,
        "recall",
        operation,
        "memories_acted_upon",
      );
      if (!Array.isArray(row.top_recalled)) {
        return dataError(
          this.access.projectId,
          "recall",
          operation,
          "top_recalled",
        );
      }
      const topRecalled = row.top_recalled.map((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          return dataError(
            this.access.projectId,
            "recall",
            operation,
            "top_recalled",
          );
        }
        const candidate = entry as Record<string, unknown>;
        return {
          id: string(
            candidate.id,
            this.access.projectId,
            "recall",
            operation,
            "top_recalled.id",
          ),
          content: string(
            candidate.content,
            this.access.projectId,
            "recall",
            operation,
            "top_recalled.content",
          ),
          actCount: nonnegativeInteger(
            candidate.actCount,
            this.access.projectId,
            "recall",
            operation,
            "top_recalled.act_count",
          ),
        };
      });
      return {
        memoriesSurfaced,
        memoriesActedUpon,
        recallPrecision: memoriesSurfaced === 0
          ? null
          : Math.min(
              100,
              (memoriesActedUpon / memoriesSurfaced) * 100,
            ),
        topRecalled,
      };
    });
  }
}

export class PostgreSqlRedactionAdminRepository
implements RedactionAdminRepository {
  private readonly access: RepositoryAccess;

  constructor(executor: RepositoryExecutor, projectId: string) {
    this.access = new RepositoryAccess(
      executor,
      projectId,
      "redaction-admin",
    );
  }

  async upsertCounts(counts: RedactionCounts): Promise<void> {
    const operation = "upsertCounts";
    const normalized = {
      gitleaks: nonnegativeInteger(
        counts.gitleaks,
        this.access.projectId,
        "redaction-admin",
        operation,
        "gitleaks",
      ),
      builtIn: nonnegativeInteger(
        counts.builtIn,
        this.access.projectId,
        "redaction-admin",
        operation,
        "built_in",
      ),
      global: nonnegativeInteger(
        counts.global,
        this.access.projectId,
        "redaction-admin",
        operation,
        "global",
      ),
      project: nonnegativeInteger(
        counts.project,
        this.access.projectId,
        "redaction-admin",
        operation,
        "project",
      ),
    };
    if (Object.values(normalized).every((count) => count === 0)) return;
    await this.access.atomic(operation, async (executor) => {
      await executor.query({
        text: `SELECT pg_catalog.pg_advisory_xact_lock(
                        pg_catalog.hashtextextended(
                          $1::pg_catalog.uuid::pg_catalog.text
                            OPERATOR(pg_catalog.||) ':redaction-counters',
                          0
                        )
                      )`,
        values: [this.access.projectId],
      }, this.access.context(operation));
      const current = await this.readCounts(executor, operation);
      const projected = {
        gitleaks: nonnegativeInteger(
          current.gitleaks + normalized.gitleaks,
          this.access.projectId,
          "redaction-admin",
          operation,
          "gitleaks",
        ),
        builtIn: nonnegativeInteger(
          current.builtIn + normalized.builtIn,
          this.access.projectId,
          "redaction-admin",
          operation,
          "built_in",
        ),
        global: nonnegativeInteger(
          current.global + normalized.global,
          this.access.projectId,
          "redaction-admin",
          operation,
          "global",
        ),
        project: nonnegativeInteger(
          current.project + normalized.project,
          this.access.projectId,
          "redaction-admin",
          operation,
          "project",
        ),
      };
      const projectedTotal = projected.gitleaks
        + projected.builtIn
        + projected.global
        + projected.project;
      if (!Number.isSafeInteger(projectedTotal)) {
        return dataError(
          this.access.projectId,
          "redaction-admin",
          operation,
          "total",
        );
      }
      await executor.query({
        text: `INSERT INTO lcm.redaction_counters (
                 project_id, category, count
               )
               SELECT $1, input.category, input.count
               FROM (
                 VALUES
                   ('gitleaks', $2::pg_catalog.int8),
                   ('built_in', $3::pg_catalog.int8),
                   ('global', $4::pg_catalog.int8),
                   ('project', $5::pg_catalog.int8)
               ) AS input(category, count)
               WHERE input.count > 0
               ON CONFLICT (project_id, category) DO UPDATE
               SET count = lcm.redaction_counters.count + EXCLUDED.count,
                   updated_at = statement_timestamp()`,
        values: [
          this.access.projectId,
          normalized.gitleaks,
          normalized.builtIn,
          normalized.global,
          normalized.project,
        ],
      }, this.access.context(operation));
    });
  }

  async getCounts(): Promise<RedactionCounts & { total: number }> {
    const operation = "getCounts";
    return this.access.read(operation, (executor) =>
      this.readCounts(executor, operation));
  }

  private async readCounts(
    executor: PostgreSqlQueryExecutor,
    operation: string,
  ): Promise<RedactionCounts & { total: number }> {
    const result = await executor.query<RedactionCountsRow>({
      text: `SELECT
               COALESCE(
                 pg_catalog.sum(count) FILTER (WHERE category = 'gitleaks'),
                 0
               ) AS gitleaks,
               COALESCE(
                 pg_catalog.sum(count) FILTER (WHERE category = 'built_in'),
                 0
               ) AS built_in,
               COALESCE(
                 pg_catalog.sum(count) FILTER (WHERE category = 'global'),
                 0
               ) AS global,
               COALESCE(
                 pg_catalog.sum(count) FILTER (WHERE category = 'project'),
                 0
               ) AS project
             FROM lcm.redaction_counters
             WHERE project_id = $1`,
      values: [this.access.projectId],
    }, this.access.context(operation));
    const row = result.rows[0];
    if (!row) {
      return dataError(
        this.access.projectId,
        "redaction-admin",
        operation,
        "counts",
      );
    }
    const counts = {
      gitleaks: nonnegativeInteger(
        row.gitleaks,
        this.access.projectId,
        "redaction-admin",
        operation,
        "gitleaks",
      ),
      builtIn: nonnegativeInteger(
        row.built_in,
        this.access.projectId,
        "redaction-admin",
        operation,
        "built_in",
      ),
      global: nonnegativeInteger(
        row.global,
        this.access.projectId,
        "redaction-admin",
        operation,
        "global",
      ),
      project: nonnegativeInteger(
        row.project,
        this.access.projectId,
        "redaction-admin",
        operation,
        "project",
      ),
    };
    const total = counts.gitleaks
      + counts.builtIn
      + counts.global
      + counts.project;
    if (!Number.isSafeInteger(total)) {
      return dataError(
        this.access.projectId,
        "redaction-admin",
        operation,
        "total",
      );
    }
    return { ...counts, total };
  }

  async purgeProjectState(): Promise<RedactionPurgeResult> {
    const operation = "purgeProjectState";
    return this.access.atomic(operation, async (executor) => {
      const deleteCount = async (text: string): Promise<unknown> => {
        const result = await executor.query<{ count: unknown }>({
          text,
          values: [this.access.projectId],
        }, this.access.context(operation));
        return result.rows[0]?.count;
      };
      const row: PurgeRow = {
        promoted_memories: 0,
        promoted_tags: await deleteCount(
          `WITH deleted AS (
             DELETE FROM lcm.promoted_memory_tags
             WHERE project_id = $1
             RETURNING 1
           )
           SELECT pg_catalog.count(*) AS count FROM deleted`,
        ),
        recall_surfacings: await deleteCount(
          `WITH deleted AS (
             DELETE FROM lcm.recall_surfacing
             WHERE project_id = $1
             RETURNING 1
           )
           SELECT pg_catalog.count(*) AS count FROM deleted`,
        ),
        redaction_counters: await deleteCount(
          `WITH deleted AS (
             DELETE FROM lcm.redaction_counters
             WHERE project_id = $1
             RETURNING 1
           )
           SELECT pg_catalog.count(*) AS count FROM deleted`,
        ),
        session_ingest_logs: await deleteCount(
          `WITH deleted AS (
             DELETE FROM lcm.session_ingest_log
             WHERE project_id = $1
             RETURNING 1
           )
           SELECT pg_catalog.count(*) AS count FROM deleted`,
        ),
        session_instructions: await deleteCount(
          `WITH deleted AS (
             DELETE FROM lcm.session_instructions
             WHERE project_id = $1
             RETURNING 1
           )
           SELECT pg_catalog.count(*) AS count FROM deleted`,
        ),
      };
      row.promoted_memories = await deleteCount(
        `WITH deleted AS (
           DELETE FROM lcm.promoted_memories
           WHERE project_id = $1
           RETURNING 1
         )
         SELECT pg_catalog.count(*) AS count FROM deleted`,
      );
      return {
        promotedMemories: nonnegativeInteger(
          row.promoted_memories,
          this.access.projectId,
          "redaction-admin",
          operation,
          "promoted_memories",
        ),
        promotedTags: nonnegativeInteger(
          row.promoted_tags,
          this.access.projectId,
          "redaction-admin",
          operation,
          "promoted_tags",
        ),
        recallSurfacings: nonnegativeInteger(
          row.recall_surfacings,
          this.access.projectId,
          "redaction-admin",
          operation,
          "recall_surfacings",
        ),
        redactionCounters: nonnegativeInteger(
          row.redaction_counters,
          this.access.projectId,
          "redaction-admin",
          operation,
          "redaction_counters",
        ),
        sessionIngestLogs: nonnegativeInteger(
          row.session_ingest_logs,
          this.access.projectId,
          "redaction-admin",
          operation,
          "session_ingest_logs",
        ),
        sessionInstructions: nonnegativeInteger(
          row.session_instructions,
          this.access.projectId,
          "redaction-admin",
          operation,
          "session_instructions",
        ),
      };
    });
  }
}

export class PostgreSqlCoordinationRepository
implements CoordinationRepository {
  private readonly access: RepositoryAccess;
  private readonly machineId: string;

  constructor(
    executor: RepositoryExecutor,
    projectId: string,
    machineId: string,
  ) {
    this.access = new RepositoryAccess(executor, projectId, "coordination");
    this.machineId = uuidV7(
      machineId,
      this.access.projectId,
      "coordination",
      "construct",
      "machine_id",
    );
  }

  async getSessionIngest(
    sessionId: string,
  ): Promise<SessionIngestRecord | null> {
    const operation = "getSessionIngest";
    const normalizedSessionId = string(
      sessionId,
      this.access.projectId,
      "coordination",
      operation,
      "session_id",
    );
    return this.access.read(operation, async (executor) => {
      const result = await executor.query<SessionIngestRow>({
        text: `SELECT ingest_key, session_id, message_count, completed_at
               FROM lcm.session_ingest_log
               WHERE project_id = $1
                 AND session_id_sha256 = public.digest($2, 'sha256')
                 AND session_id = $2
               ORDER BY ingest_key
               LIMIT 1`,
        values: [this.access.projectId, normalizedSessionId],
      }, this.access.context(operation));
      const row = result.rows[0];
      return row ? this.sessionIngestFromRow(row, operation) : null;
    });
  }

  async recordSessionIngest(
    sessionId: string,
    messageCount: number,
  ): Promise<void> {
    const operation = "recordSessionIngest";
    const normalizedSessionId = string(
      sessionId,
      this.access.projectId,
      "coordination",
      operation,
      "session_id",
    );
    const normalizedMessageCount = nonnegativeInteger(
      messageCount,
      this.access.projectId,
      "coordination",
      operation,
      "message_count",
    );
    await this.access.readCommittedAtomic(operation, async (executor) => {
      await executor.query({
        text: `SELECT pg_catalog.pg_advisory_xact_lock(
                        pg_catalog.hashtextextended(
                          $1::pg_catalog.uuid::pg_catalog.text
                            OPERATOR(pg_catalog.||) ':session-ingest:'
                            OPERATOR(pg_catalog.||)
                              pg_catalog.encode(
                                public.digest($2, 'sha256'),
                                'hex'
                              ),
                          0
                        )
                      )`,
        values: [this.access.projectId, normalizedSessionId],
      }, this.access.context(operation));
      const existing = await executor.query<SessionIngestRow>({
        text: `SELECT ingest_key, session_id, message_count, completed_at
               FROM lcm.session_ingest_log
               WHERE project_id = $1
                 AND session_id_sha256 = public.digest($2, 'sha256')
                 AND session_id = $2
               ORDER BY ingest_key
               LIMIT 1
               FOR UPDATE`,
        values: [this.access.projectId, normalizedSessionId],
      }, this.access.context(operation));
      const row = existing.rows[0];
      if (row) {
        const ingestKey = uuidV7(
          row.ingest_key,
          this.access.projectId,
          "coordination",
          operation,
          "ingest_key",
        );
        await executor.query({
          text: `UPDATE lcm.session_ingest_log
                 SET message_count = $3,
                     completed_at = statement_timestamp()
                 WHERE project_id = $1
                   AND ingest_key = $2`,
          values: [
            this.access.projectId,
            ingestKey,
            normalizedMessageCount,
          ],
        }, this.access.context(operation));
      } else {
        await executor.query({
          text: `INSERT INTO lcm.session_ingest_log (
                   project_id, session_id, message_count
                 )
                 VALUES ($1, $2, $3)`,
          values: [
            this.access.projectId,
            normalizedSessionId,
            normalizedMessageCount,
          ],
        }, this.access.context(operation));
      }
    });
  }

  async getSessionInstructions(
    id: number,
    fallbackLegacyId?: number,
  ): Promise<SessionInstructionsRecord | null> {
    const operation = "getSessionInstructions";
    const slot = nonnegativeInteger(
      id,
      this.access.projectId,
      "coordination",
      operation,
      "slot",
    );
    const fallbackSlot = fallbackLegacyId === undefined
      ? null
      : nonnegativeInteger(
          fallbackLegacyId,
          this.access.projectId,
          "coordination",
          operation,
          "fallback_slot",
        );
    return this.access.read(operation, async (executor) => {
      const result = await executor.query<SessionInstructionsRow>({
        text: `SELECT slot, content, content_hash, updated_at
               FROM lcm.session_instructions
               WHERE project_id = $1
                 AND (
                   (machine_id = $2 AND slot = $3)
                   OR (
                     $4::pg_catalog.int4 IS NOT NULL
                     AND machine_id IS NULL
                     AND slot = $4
                   )
                 )
               ORDER BY CASE
                 WHEN machine_id = $2 AND slot = $3 THEN 0
                 ELSE 1
               END
               LIMIT 1`,
        values: [
          this.access.projectId,
          this.machineId,
          slot,
          fallbackSlot,
        ],
      }, this.access.context(operation));
      const row = result.rows[0];
      return row ? this.sessionInstructionsFromRow(row, operation) : null;
    });
  }

  async upsertSessionInstructions(
    id: number,
    content: string,
    contentHash: string,
  ): Promise<void> {
    const operation = "upsertSessionInstructions";
    const slot = nonnegativeInteger(
      id,
      this.access.projectId,
      "coordination",
      operation,
      "slot",
    );
    const normalizedContent = string(
      content,
      this.access.projectId,
      "coordination",
      operation,
      "content",
    );
    const normalizedContentHash = string(
      contentHash,
      this.access.projectId,
      "coordination",
      operation,
      "content_hash",
    );
    await this.access.atomic(operation, async (executor) => {
      await executor.query({
        text: `INSERT INTO lcm.session_instructions (
                 project_id, machine_id, slot, content, content_hash
               )
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (project_id, machine_id, slot) DO UPDATE
               SET content = EXCLUDED.content,
                   content_hash = EXCLUDED.content_hash,
                   updated_at = statement_timestamp()`,
        values: [
          this.access.projectId,
          this.machineId,
          slot,
          normalizedContent,
          normalizedContentHash,
        ],
      }, this.access.context(operation));
    });
  }

  async deleteSessionInstructions(id: number): Promise<void> {
    const operation = "deleteSessionInstructions";
    const slot = nonnegativeInteger(
      id,
      this.access.projectId,
      "coordination",
      operation,
      "slot",
    );
    await this.access.atomic(operation, async (executor) => {
      await executor.query({
        text: `DELETE FROM lcm.session_instructions
               WHERE project_id = $1
                 AND machine_id = $2
                 AND slot = $3`,
        values: [this.access.projectId, this.machineId, slot],
      }, this.access.context(operation));
    });
  }

  private sessionIngestFromRow(
    row: SessionIngestRow,
    operation: string,
  ): SessionIngestRecord {
    uuidV7(
      row.ingest_key,
      this.access.projectId,
      "coordination",
      operation,
      "ingest_key",
    );
    return {
      sessionId: string(
        row.session_id,
        this.access.projectId,
        "coordination",
        operation,
        "session_id",
      ),
      messageCount: nonnegativeInteger(
        row.message_count,
        this.access.projectId,
        "coordination",
        operation,
        "message_count",
      ),
      completedAt: timestamp(
        row.completed_at,
        this.access.projectId,
        "coordination",
        operation,
        "completed_at",
      ),
    };
  }

  private sessionInstructionsFromRow(
    row: SessionInstructionsRow,
    operation: string,
  ): SessionInstructionsRecord {
    return {
      id: nonnegativeInteger(
        row.slot,
        this.access.projectId,
        "coordination",
        operation,
        "slot",
      ),
      content: string(
        row.content,
        this.access.projectId,
        "coordination",
        operation,
        "content",
      ),
      contentHash: string(
        row.content_hash,
        this.access.projectId,
        "coordination",
        operation,
        "content_hash",
      ),
      updatedAt: timestamp(
        row.updated_at,
        this.access.projectId,
        "coordination",
        operation,
        "updated_at",
      ),
    };
  }
}

export type PostgreSqlMemoryRepositoryDomain = Extract<
  StorageDomain,
  RepositoryDomain
>;
