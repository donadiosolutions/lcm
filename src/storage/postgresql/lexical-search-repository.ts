import type { QueryResultRow } from "pg";
import type { SearchResult } from "../../db/promoted.js";
import type {
  MessageRole,
  MessageSearchInput,
  MessageSearchResult,
} from "../../store/conversation-store.js";
import { validateRegex } from "../../store/regex-safety.js";
import type {
  SummaryKind,
  SummarySearchInput,
  SummarySearchResult,
} from "../../store/summary-store.js";
import type { LexicalSearchRepository } from "../contracts.js";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlOperationContext,
  PostgreSqlQueryExecutor,
  PostgreSqlTransactionScopeExecutor,
} from "./contracts.js";

const MAX_SEARCH_LIMIT = 1_000;
const DEFAULT_SEARCH_LIMIT = 50;
const SEARCH_TIMEOUT_CAP_MS = 5_000;
// Exact empty replacements from migration 0002's pinned unaccent-derived map,
// plus Unicode whitespace. PostgreSQL preserves the whitespace while removing
// the mapped characters, leaving no full-text lexeme and an unsafe broad
// trigram pattern. U+FEFF is included because the repository's String.trim()
// boundary already treats it as whitespace even though Unicode White_Space
// does not. Punctuation and all other text remain searchable.
const NORMALIZATION_EMPTY_INPUT =
  /^[\p{White_Space}\uFEFF\u0300-\u0362\u20dd-\u20e0\u20e2-\u20e4]+$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MESSAGE_ROLES = new Set<MessageRole>([
  "system",
  "user",
  "assistant",
  "tool",
]);
const SUMMARY_KINDS = new Set<SummaryKind>(["leaf", "condensed"]);

type SearchOperation = "searchMessages" | "searchSummaries" | "searchPromoted";

type SearchContext = PostgreSqlOperationContext & {
  readonly domain: "lexical-search";
  readonly projectId: string;
};

export interface PostgreSqlLexicalSearchExecutor
  extends PostgreSqlQueryExecutor {
  transaction<T>(
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: SearchContext
  ): Promise<T>;
}

export interface PostgreSqlLexicalSearchScopedExecutor
  extends PostgreSqlTransactionScopeExecutor {}

type RepositoryExecutor =
  | PostgreSqlLexicalSearchExecutor
  | PostgreSqlLexicalSearchScopedExecutor;

type ScopedExecutorState = { tail: Promise<void> };
const scopedExecutorStates = new WeakMap<
  PostgreSqlLexicalSearchScopedExecutor,
  ScopedExecutorState
>();

type MessageSearchRow = QueryResultRow & {
  message_id: unknown;
  conversation_id: unknown;
  role: unknown;
  snippet: unknown;
  rank: unknown;
  created_at: unknown;
};

type SummarySearchRow = QueryResultRow & {
  summary_id: unknown;
  conversation_id: unknown;
  kind: unknown;
  snippet: unknown;
  rank: unknown;
  created_at: unknown;
};

type PromotedSearchRow = QueryResultRow & {
  memory_id: unknown;
  content: unknown;
  tags: unknown;
  source_project_id: unknown;
  session_id: unknown;
  confidence: unknown;
  created_at: unknown;
  rank: unknown;
};

type MatchPhaseRow = QueryResultRow & {
  match_phase: unknown;
};

type CombinedMessageSearchRow = MessageSearchRow & MatchPhaseRow;
type CombinedSummarySearchRow = SummarySearchRow & MatchPhaseRow;
type CombinedPromotedSearchRow = PromotedSearchRow & MatchPhaseRow;

type TimeoutRow = QueryResultRow & {
  previous_timeout: unknown;
};

type SearchInputSnapshot = {
  readonly conversationId: number | null;
  readonly query: string;
  readonly mode: "regex" | "full_text";
  readonly since: string | null;
  readonly before: string | null;
  readonly limit: number;
};

export class PostgreSqlLexicalSearchDataError extends StorageOperationError {
  constructor(
    projectId: string,
    operation: SearchOperation | "construct",
    readonly field: string
  ) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      projectId,
      "lexical-search",
      operation
    );
    this.name = "PostgreSqlLexicalSearchDataError";
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), field: this.field };
  }
}

function dataError(
  projectId: string,
  operation: SearchOperation | "construct",
  field: string
): never {
  throw new PostgreSqlLexicalSearchDataError(projectId, operation, field);
}

function validatedString(
  value: unknown,
  projectId: string,
  operation: SearchOperation | "construct",
  field: string
): string {
  if (typeof value !== "string") {
    return dataError(projectId, operation, field);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) return dataError(projectId, operation, field);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        return dataError(projectId, operation, field);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return dataError(projectId, operation, field);
    }
  }
  return value;
}

function projectUuidV7(value: unknown): string {
  const placeholder = "<invalid-project>";
  const candidate = validatedString(
    value,
    placeholder,
    "construct",
    "project_id"
  );
  if (!UUID_PATTERN.test(candidate) || !UUIDV7_PATTERN.test(candidate)) {
    return dataError(placeholder, "construct", "project_id");
  }
  return candidate.toLowerCase();
}

function safeInteger(
  value: unknown,
  projectId: string,
  operation: SearchOperation,
  field: string
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return dataError(projectId, operation, field);
  }
  return value;
}

function nonnegativeInteger(
  value: unknown,
  projectId: string,
  operation: SearchOperation,
  field: string
): number {
  const candidate = safeInteger(value, projectId, operation, field);
  return candidate < 0 ? dataError(projectId, operation, field) : candidate;
}

function resultInteger(
  value: unknown,
  projectId: string,
  operation: SearchOperation,
  field: string
): number {
  if (typeof value === "number") {
    return Number.isSafeInteger(value)
      ? value
      : dataError(projectId, operation, field);
  }
  if (
    typeof value !== "bigint" &&
    (typeof value !== "string" || !/^-?\d+$/u.test(value))
  ) {
    return dataError(projectId, operation, field);
  }
  const candidate = typeof value === "bigint" ? value : BigInt(value);
  if (
    candidate < BigInt(Number.MIN_SAFE_INTEGER) ||
    candidate > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return dataError(projectId, operation, field);
  }
  return Number(candidate);
}

function finiteNumber(
  value: unknown,
  projectId: string,
  operation: SearchOperation,
  field: string
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return dataError(projectId, operation, field);
  }
  return value;
}

function promotedRank(
  value: unknown,
  projectId: string,
  operation: "searchPromoted",
  source: "primary" | "fallback"
): number {
  const candidate = finiteNumber(value, projectId, operation, "rank");
  if (
    (source === "primary" && candidate >= 0) ||
    (source === "fallback" && candidate < 0)
  ) {
    return dataError(projectId, operation, "rank");
  }
  return candidate;
}

function resultNonnegativeInteger(
  value: unknown,
  projectId: string,
  operation: SearchOperation,
  field: string
): number {
  const candidate = resultInteger(value, projectId, operation, field);
  return candidate < 0 ? dataError(projectId, operation, field) : candidate;
}

function matchPhase(
  value: unknown,
  projectId: string,
  operation: SearchOperation
): "primary" | "fallback" {
  const candidate = resultNonnegativeInteger(
    value,
    projectId,
    operation,
    "match_phase"
  );
  if (candidate === 0) return "primary";
  if (candidate === 1) return "fallback";
  return dataError(projectId, operation, "match_phase");
}

function timestamp(
  value: unknown,
  projectId: string,
  operation: SearchOperation,
  field: string
): Date {
  const candidate =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === "string"
      ? new Date(value)
      : new Date(Number.NaN);
  if (!Number.isFinite(candidate.getTime())) {
    return dataError(projectId, operation, field);
  }
  return candidate;
}

function inputTimestamp(
  value: unknown,
  projectId: string,
  operation: SearchOperation,
  field: string
): string {
  if (!(value instanceof Date)) {
    return dataError(projectId, operation, field);
  }
  return timestamp(value, projectId, operation, field).toISOString();
}

function searchLimit(
  value: unknown,
  projectId: string,
  operation: SearchOperation
): number {
  const candidate = nonnegativeInteger(value, projectId, operation, "limit");
  return candidate > MAX_SEARCH_LIMIT
    ? dataError(projectId, operation, "limit")
    : candidate;
}

function snapshotInput(
  inputValue: unknown,
  projectId: string,
  operation: "searchMessages" | "searchSummaries"
): SearchInputSnapshot {
  if (
    typeof inputValue !== "object" ||
    inputValue === null ||
    Array.isArray(inputValue)
  ) {
    return dataError(projectId, operation, "input");
  }
  const input = inputValue as MessageSearchInput | SummarySearchInput;
  const query = validatedString(input.query, projectId, operation, "query");
  const mode = input.mode;
  if (mode !== "regex" && mode !== "full_text") {
    return dataError(projectId, operation, "mode");
  }
  if (mode === "regex") {
    try {
      validateRegex(query);
    } catch {
      return dataError(projectId, operation, "query");
    }
  }
  return {
    conversationId:
      input.conversationId === undefined
        ? null
        : nonnegativeInteger(
            input.conversationId,
            projectId,
            operation,
            "conversation_id"
          ),
    query,
    mode,
    since:
      input.since === undefined
        ? null
        : inputTimestamp(input.since, projectId, operation, "since"),
    before:
      input.before === undefined
        ? null
        : inputTimestamp(input.before, projectId, operation, "before"),
    limit: searchLimit(
      input.limit === undefined ? DEFAULT_SEARCH_LIMIT : input.limit,
      projectId,
      operation
    ),
  };
}

function tags(
  value: unknown,
  projectId: string,
  operation: SearchOperation,
  field = "tags"
): string[] {
  if (!Array.isArray(value)) {
    return dataError(projectId, operation, field);
  }
  return value.map((tag) => validatedString(tag, projectId, operation, field));
}

function uuid(
  value: unknown,
  projectId: string,
  operation: SearchOperation,
  field: string
): string {
  const candidate = validatedString(value, projectId, operation, field);
  return UUID_PATTERN.test(candidate)
    ? candidate.toLowerCase()
    : dataError(projectId, operation, field);
}

function messageFromRow(
  row: MessageSearchRow,
  projectId: string,
  operation: "searchMessages"
): MessageSearchResult {
  const role = validatedString(row.role, projectId, operation, "role");
  if (!MESSAGE_ROLES.has(role as MessageRole)) {
    return dataError(projectId, operation, "role");
  }
  return {
    messageId: resultNonnegativeInteger(
      row.message_id,
      projectId,
      operation,
      "message_id"
    ),
    conversationId: resultNonnegativeInteger(
      row.conversation_id,
      projectId,
      operation,
      "conversation_id"
    ),
    role: role as MessageRole,
    snippet: validatedString(row.snippet, projectId, operation, "snippet"),
    createdAt: timestamp(row.created_at, projectId, operation, "created_at"),
    rank: finiteNumber(row.rank, projectId, operation, "rank"),
  };
}

function summaryFromRow(
  row: SummarySearchRow,
  projectId: string,
  operation: "searchSummaries"
): SummarySearchResult {
  const kind = validatedString(row.kind, projectId, operation, "kind");
  if (!SUMMARY_KINDS.has(kind as SummaryKind)) {
    return dataError(projectId, operation, "kind");
  }
  return {
    summaryId: validatedString(
      row.summary_id,
      projectId,
      operation,
      "summary_id"
    ),
    conversationId: resultNonnegativeInteger(
      row.conversation_id,
      projectId,
      operation,
      "conversation_id"
    ),
    kind: kind as SummaryKind,
    snippet: validatedString(row.snippet, projectId, operation, "snippet"),
    createdAt: timestamp(row.created_at, projectId, operation, "created_at"),
    rank: finiteNumber(row.rank, projectId, operation, "rank"),
  };
}

function promotedFromRow(
  row: PromotedSearchRow,
  projectId: string,
  operation: "searchPromoted",
  source: "primary" | "fallback"
): SearchResult {
  return {
    id: uuid(row.memory_id, projectId, operation, "memory_id"),
    content: validatedString(row.content, projectId, operation, "content"),
    tags: tags(row.tags, projectId, operation),
    projectId:
      row.source_project_id === null
        ? projectId
        : validatedString(
            row.source_project_id,
            projectId,
            operation,
            "source_project_id"
          ),
    sessionId:
      row.session_id === null
        ? null
        : validatedString(row.session_id, projectId, operation, "session_id"),
    confidence: finiteNumber(
      row.confidence,
      projectId,
      operation,
      "confidence"
    ),
    createdAt: timestamp(
      row.created_at,
      projectId,
      operation,
      "created_at"
    ).toISOString(),
    rank: promotedRank(row.rank, projectId, operation, source),
  };
}

function appendDeduplicated<Result>(
  primary: readonly Result[],
  fallback: readonly Result[],
  id: (result: Result) => string | number,
  limit: number
): Result[] {
  const result = primary.slice(0, limit);
  if (result.length >= limit) return result;
  const seen = new Set(result.map(id));
  for (const candidate of fallback) {
    const candidateId = id(candidate);
    if (!seen.has(candidateId)) {
      result.push(candidate);
      seen.add(candidateId);
    }
    if (result.length >= limit) break;
  }
  return result;
}

function decodeCombinedRows<Row extends MatchPhaseRow, Result>(
  rows: readonly Row[],
  projectId: string,
  operation: SearchOperation,
  decode: (row: Row, phase: "primary" | "fallback") => Result,
  id: (result: Result) => string | number,
  limit: number
): Result[] {
  const primary: Result[] = [];
  const fallback: Result[] = [];
  for (const row of rows) {
    const phase = matchPhase(row.match_phase, projectId, operation);
    (phase === "primary" ? primary : fallback).push(decode(row, phase));
  }
  return appendDeduplicated(primary, fallback, id, limit);
}

function normalizesToEmpty(query: string): boolean {
  return NORMALIZATION_EMPTY_INPUT.test(query);
}

function boundedStatementTimeoutMs(
  value: unknown,
  projectId: string,
  operation: SearchOperation
): number {
  const timeout = validatedString(
    value,
    projectId,
    operation,
    "statement_timeout"
  );
  const match = /^(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?$/u.exec(timeout);
  if (match === null) {
    return dataError(projectId, operation, "statement_timeout");
  }
  const magnitude = Number(match[1]);
  const multiplier = (
    {
      us: 0.001,
      ms: 1,
      s: 1_000,
      min: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    } as const
  )[(match[2] ?? "ms") as "us" | "ms" | "s" | "min" | "h" | "d"];
  const milliseconds = magnitude * multiplier;
  if (!Number.isFinite(milliseconds)) {
    return dataError(projectId, operation, "statement_timeout");
  }
  return milliseconds === 0
    ? SEARCH_TIMEOUT_CAP_MS
    : Math.min(SEARCH_TIMEOUT_CAP_MS, Math.max(1, Math.ceil(milliseconds)));
}

class RepositoryAccess {
  readonly projectId: string;

  constructor(
    private readonly executor: RepositoryExecutor,
    projectId: string
  ) {
    this.projectId = projectUuidV7(projectId);
  }

  context(operation: SearchOperation): SearchContext {
    return {
      domain: "lexical-search",
      operation,
      projectId: this.projectId,
    };
  }

  atomic<T>(
    operation: SearchOperation,
    callback: (executor: PostgreSqlQueryExecutor) => Promise<T>
  ): Promise<T> {
    const root = this.rootExecutor();
    return root
      ? root.transaction(callback, this.context(operation))
      : this.scopedSerialized(operation, (executor) =>
          executor.savepoint(callback, this.context(operation))
        );
  }

  private rootExecutor(): PostgreSqlLexicalSearchExecutor | null {
    return "transaction" in this.executor &&
      typeof this.executor.transaction === "function"
      ? this.executor
      : null;
  }

  private scopedSerialized<T>(
    operation: SearchOperation,
    callback: (executor: PostgreSqlLexicalSearchScopedExecutor) => Promise<T>
  ): Promise<T> {
    if (
      this.executor.transactionScope !== "active" ||
      !("savepoint" in this.executor) ||
      typeof this.executor.savepoint !== "function"
    ) {
      return Promise.reject(
        new StorageOperationError(
          "STORAGE_TRANSACTION_SCOPE",
          "postgresql",
          this.projectId,
          "lexical-search",
          operation
        )
      );
    }
    const executor = this.executor as PostgreSqlLexicalSearchScopedExecutor;
    const state = scopedExecutorStates.get(executor) ?? {
      tail: Promise.resolve(),
    };
    scopedExecutorStates.set(executor, state);
    const execute = state.tail.then(() => callback(executor));
    state.tail = execute.then(
      () => undefined,
      () => undefined
    );
    return execute;
  }
}

async function withBoundedSearch<T>(
  executor: PostgreSqlQueryExecutor,
  context: SearchContext,
  callback: () => Promise<T>
): Promise<T> {
  const timeout = await executor.query<TimeoutRow>(
    {
      text: `SELECT
             pg_catalog.current_setting('statement_timeout')
               AS previous_timeout`,
    },
    context
  );
  const previousTimeout = validatedString(
    timeout.rows[0]?.previous_timeout,
    context.projectId,
    context.operation as SearchOperation,
    "statement_timeout"
  );
  const effectiveTimeout = boundedStatementTimeoutMs(
    timeout.rows[0]?.previous_timeout,
    context.projectId,
    context.operation as SearchOperation
  );
  await executor.query(
    {
      text: `SELECT pg_catalog.set_config(
             'statement_timeout',
             $1::pg_catalog.text,
             true
           )`,
      values: [`${effectiveTimeout}ms`],
    },
    context
  );
  const result = await callback();
  await executor.query(
    {
      text: `SELECT pg_catalog.set_config(
             'statement_timeout',
             $1::pg_catalog.text,
             true
           )`,
      values: [previousTimeout],
    },
    context
  );
  return result;
}

const MESSAGE_FULL_TEXT_SQL = `WITH input AS MATERIALIZED (
  SELECT
    normalized.query,
    pg_catalog.websearch_to_tsquery(
      'lcm.search_v1'::pg_catalog.regconfig,
      normalized.query
    ) AS full_text_query
  FROM (
    SELECT lcm.normalize_search_text($2::pg_catalog.text) AS query
  ) AS normalized
),
primary_rows AS MATERIALIZED (
  SELECT
    ranked.message_id,
    ranked.conversation_id,
    ranked.role,
    ranked.snippet,
    ranked.rank,
    ranked.created_at,
    0::pg_catalog.int2 AS match_phase,
    ranked.rank AS match_order
  FROM (
    SELECT
      message.message_id,
      message.conversation_id,
      message.role,
      pg_catalog.left(
        pg_catalog.ts_headline(
          'lcm.search_v1'::pg_catalog.regconfig,
          lcm.normalize_search_text(message.content),
          input.full_text_query,
          'StartSel=, StopSel=, MaxWords=32, MinWords=8, ShortWord=1, MaxFragments=1, FragmentDelimiter= … '
        ),
        512
      ) AS snippet,
      pg_catalog.ts_rank_cd(
        message.search_document,
        input.full_text_query
      ) AS rank,
      message.created_at
    FROM lcm.messages AS message
    CROSS JOIN input
    WHERE message.project_id OPERATOR(pg_catalog.=) $1::pg_catalog.uuid
      AND (
        $3::pg_catalog.int8 IS NULL
        OR message.conversation_id OPERATOR(pg_catalog.=) $3::pg_catalog.int8
      )
      AND (
        $4::pg_catalog.timestamptz IS NULL
        OR message.created_at OPERATOR(pg_catalog.>=)
          $4::pg_catalog.timestamptz
      )
      AND (
        $5::pg_catalog.timestamptz IS NULL
        OR message.created_at OPERATOR(pg_catalog.<)
          $5::pg_catalog.timestamptz
      )
      AND message.search_document
        OPERATOR(pg_catalog.@@) input.full_text_query
  ) AS ranked
  ORDER BY ranked.rank DESC, ranked.created_at DESC, ranked.message_id DESC
  LIMIT $6::pg_catalog.int8
),
fallback_budget AS MATERIALIZED (
  SELECT GREATEST(
           $6::pg_catalog.int8
             OPERATOR(pg_catalog.-)
             pg_catalog.count(*)::pg_catalog.int8,
           0::pg_catalog.int8
         ) AS remaining
  FROM primary_rows
),
fallback_rows AS MATERIALIZED (
  SELECT
    fallback.message_id,
    fallback.conversation_id,
    fallback.role,
    fallback.snippet,
    fallback.rank,
    fallback.created_at,
    1::pg_catalog.int2 AS match_phase,
    fallback.rank AS match_order
  FROM input
  CROSS JOIN fallback_budget
  CROSS JOIN LATERAL (
    SELECT
      scored.message_id,
      scored.conversation_id,
      scored.role,
      scored.snippet,
      scored.rank,
      scored.created_at
    FROM (
      SELECT
        candidate.message_id,
        candidate.conversation_id,
        candidate.role,
        pg_catalog.left(candidate.content, 512) AS snippet,
        GREATEST(
          public.similarity(
            candidate.normalized_content,
            candidate.query
          ),
          CASE
            WHEN candidate.normalized_content
              OPERATOR(pg_catalog.~~) candidate.substring_pattern
              THEN 1::pg_catalog.float4
            ELSE 0::pg_catalog.float4
          END
        ) AS rank,
        candidate.created_at
      FROM (
        SELECT
          message.message_id,
          message.conversation_id,
          message.role,
          message.content,
          message.created_at,
          lcm.normalize_search_text(message.content) AS normalized_content,
          input.query,
          (
            '%' OPERATOR(pg_catalog.||)
            pg_catalog.replace(
              pg_catalog.replace(
                pg_catalog.replace(input.query, E'\\\\', E'\\\\\\\\'),
                '%',
                E'\\\\%'
              ),
              '_',
              E'\\\\_'
            )
            OPERATOR(pg_catalog.||) '%'
          ) AS substring_pattern
        FROM lcm.messages AS message
        WHERE pg_catalog.octet_length(input.query)
            OPERATOR(pg_catalog.>=) 3
          AND fallback_budget.remaining OPERATOR(pg_catalog.>) 0
          AND message.project_id OPERATOR(pg_catalog.=) $1::pg_catalog.uuid
          AND (
            $3::pg_catalog.int8 IS NULL
            OR message.conversation_id
              OPERATOR(pg_catalog.=) $3::pg_catalog.int8
          )
          AND (
            $4::pg_catalog.timestamptz IS NULL
            OR message.created_at OPERATOR(pg_catalog.>=)
              $4::pg_catalog.timestamptz
          )
          AND (
            $5::pg_catalog.timestamptz IS NULL
            OR message.created_at OPERATOR(pg_catalog.<)
              $5::pg_catalog.timestamptz
          )
          AND NOT EXISTS (
            SELECT 1
            FROM primary_rows AS primary_row
            WHERE primary_row.message_id
              OPERATOR(pg_catalog.=) message.message_id
          )
          AND (
            lcm.normalize_search_text(message.content)
              OPERATOR(public.%) input.query
            OR lcm.normalize_search_text(message.content)
              OPERATOR(pg_catalog.~~)
              (
                '%' OPERATOR(pg_catalog.||)
                pg_catalog.replace(
                  pg_catalog.replace(
                    pg_catalog.replace(input.query, E'\\\\', E'\\\\\\\\'),
                    '%',
                    E'\\\\%'
                  ),
                  '_',
                  E'\\\\_'
                )
                OPERATOR(pg_catalog.||) '%'
              )
          )
      ) AS candidate
    ) AS scored
    ORDER BY
      scored.rank DESC,
      scored.created_at DESC,
      scored.message_id DESC
    LIMIT CASE
      WHEN pg_catalog.octet_length(input.query)
          OPERATOR(pg_catalog.>=) 3
        AND fallback_budget.remaining OPERATOR(pg_catalog.>) 0
        THEN GREATEST(
          fallback_budget.remaining,
          0::pg_catalog.int8
        )
      ELSE 0::pg_catalog.int8
    END
  ) AS fallback
),
combined AS (
  SELECT * FROM primary_rows
  UNION ALL
  SELECT * FROM fallback_rows
)
SELECT
  combined.message_id,
  combined.conversation_id,
  combined.role,
  combined.snippet,
  combined.rank,
  combined.created_at,
  combined.match_phase
FROM combined
ORDER BY
  combined.match_phase,
  combined.match_order DESC,
  combined.created_at DESC,
  combined.message_id DESC
LIMIT $6::pg_catalog.int8`;

const MESSAGE_REGEX_SQL = `SELECT
  message.message_id,
  message.conversation_id,
  message.role,
  pg_catalog.left(
    pg_catalog.regexp_substr(message.content, $2::pg_catalog.text),
    512
  ) AS snippet,
  0::pg_catalog.float4 AS rank,
  message.created_at
FROM lcm.messages AS message
WHERE message.project_id OPERATOR(pg_catalog.=) $1::pg_catalog.uuid
  AND (
    $3::pg_catalog.int8 IS NULL
    OR message.conversation_id OPERATOR(pg_catalog.=) $3::pg_catalog.int8
  )
  AND (
    $4::pg_catalog.timestamptz IS NULL
    OR message.created_at OPERATOR(pg_catalog.>=) $4::pg_catalog.timestamptz
  )
  AND (
    $5::pg_catalog.timestamptz IS NULL
    OR message.created_at OPERATOR(pg_catalog.<) $5::pg_catalog.timestamptz
  )
  AND message.content OPERATOR(pg_catalog.~) $2::pg_catalog.text
ORDER BY message.created_at DESC, message.message_id DESC
LIMIT $6::pg_catalog.int8`;

const SUMMARY_FULL_TEXT_SQL = `WITH input AS MATERIALIZED (
  SELECT
    normalized.query,
    pg_catalog.websearch_to_tsquery(
      'lcm.search_v1'::pg_catalog.regconfig,
      normalized.query
    ) AS full_text_query
  FROM (
    SELECT lcm.normalize_search_text($2::pg_catalog.text) AS query
  ) AS normalized
),
primary_rows AS MATERIALIZED (
  SELECT
    ranked.summary_id,
    ranked.conversation_id,
    ranked.kind,
    ranked.snippet,
    ranked.rank,
    ranked.created_at,
    0::pg_catalog.int2 AS match_phase,
    ranked.rank AS match_order
  FROM (
    SELECT
      summary.summary_id,
      summary.conversation_id,
      summary.kind,
      pg_catalog.left(
        pg_catalog.ts_headline(
          'lcm.search_v1'::pg_catalog.regconfig,
          lcm.normalize_search_text(summary.content),
          input.full_text_query,
          'StartSel=, StopSel=, MaxWords=32, MinWords=8, ShortWord=1, MaxFragments=1, FragmentDelimiter= … '
        ),
        512
      ) AS snippet,
      pg_catalog.ts_rank_cd(
        summary.search_document,
        input.full_text_query
      ) AS rank,
      summary.created_at
    FROM lcm.summaries AS summary
    CROSS JOIN input
    WHERE summary.project_id OPERATOR(pg_catalog.=) $1::pg_catalog.uuid
      AND (
        $3::pg_catalog.int8 IS NULL
        OR summary.conversation_id OPERATOR(pg_catalog.=) $3::pg_catalog.int8
      )
      AND (
        $4::pg_catalog.timestamptz IS NULL
        OR summary.created_at OPERATOR(pg_catalog.>=)
          $4::pg_catalog.timestamptz
      )
      AND (
        $5::pg_catalog.timestamptz IS NULL
        OR summary.created_at OPERATOR(pg_catalog.<)
          $5::pg_catalog.timestamptz
      )
      AND summary.search_document
        OPERATOR(pg_catalog.@@) input.full_text_query
  ) AS ranked
  ORDER BY ranked.rank DESC, ranked.created_at DESC, ranked.summary_id DESC
  LIMIT $6::pg_catalog.int8
),
fallback_budget AS MATERIALIZED (
  SELECT GREATEST(
           $6::pg_catalog.int8
             OPERATOR(pg_catalog.-)
             pg_catalog.count(*)::pg_catalog.int8,
           0::pg_catalog.int8
         ) AS remaining
  FROM primary_rows
),
fallback_rows AS MATERIALIZED (
  SELECT
    fallback.summary_id,
    fallback.conversation_id,
    fallback.kind,
    fallback.snippet,
    fallback.rank,
    fallback.created_at,
    1::pg_catalog.int2 AS match_phase,
    fallback.rank AS match_order
  FROM input
  CROSS JOIN fallback_budget
  CROSS JOIN LATERAL (
    SELECT
      scored.summary_id,
      scored.conversation_id,
      scored.kind,
      scored.snippet,
      scored.rank,
      scored.created_at
    FROM (
      SELECT
        candidate.summary_id,
        candidate.conversation_id,
        candidate.kind,
        pg_catalog.left(candidate.content, 512) AS snippet,
        GREATEST(
          public.similarity(
            candidate.normalized_content,
            candidate.query
          ),
          CASE
            WHEN candidate.normalized_content
              OPERATOR(pg_catalog.~~) candidate.substring_pattern
              THEN 1::pg_catalog.float4
            ELSE 0::pg_catalog.float4
          END
        ) AS rank,
        candidate.created_at
      FROM (
        SELECT
          summary.summary_id,
          summary.conversation_id,
          summary.kind,
          summary.content,
          summary.created_at,
          lcm.normalize_search_text(summary.content) AS normalized_content,
          input.query,
          (
            '%' OPERATOR(pg_catalog.||)
            pg_catalog.replace(
              pg_catalog.replace(
                pg_catalog.replace(input.query, E'\\\\', E'\\\\\\\\'),
                '%',
                E'\\\\%'
              ),
              '_',
              E'\\\\_'
            )
            OPERATOR(pg_catalog.||) '%'
          ) AS substring_pattern
        FROM lcm.summaries AS summary
        WHERE pg_catalog.octet_length(input.query)
            OPERATOR(pg_catalog.>=) 3
          AND fallback_budget.remaining OPERATOR(pg_catalog.>) 0
          AND summary.project_id OPERATOR(pg_catalog.=) $1::pg_catalog.uuid
          AND (
            $3::pg_catalog.int8 IS NULL
            OR summary.conversation_id
              OPERATOR(pg_catalog.=) $3::pg_catalog.int8
          )
          AND (
            $4::pg_catalog.timestamptz IS NULL
            OR summary.created_at OPERATOR(pg_catalog.>=)
              $4::pg_catalog.timestamptz
          )
          AND (
            $5::pg_catalog.timestamptz IS NULL
            OR summary.created_at OPERATOR(pg_catalog.<)
              $5::pg_catalog.timestamptz
          )
          AND NOT EXISTS (
            SELECT 1
            FROM primary_rows AS primary_row
            WHERE primary_row.summary_id
              OPERATOR(pg_catalog.=) summary.summary_id
          )
          AND (
            lcm.normalize_search_text(summary.content)
              OPERATOR(public.%) input.query
            OR lcm.normalize_search_text(summary.content)
              OPERATOR(pg_catalog.~~)
              (
                '%' OPERATOR(pg_catalog.||)
                pg_catalog.replace(
                  pg_catalog.replace(
                    pg_catalog.replace(input.query, E'\\\\', E'\\\\\\\\'),
                    '%',
                    E'\\\\%'
                  ),
                  '_',
                  E'\\\\_'
                )
                OPERATOR(pg_catalog.||) '%'
              )
          )
      ) AS candidate
    ) AS scored
    ORDER BY
      scored.rank DESC,
      scored.created_at DESC,
      scored.summary_id DESC
    LIMIT CASE
      WHEN pg_catalog.octet_length(input.query)
          OPERATOR(pg_catalog.>=) 3
        AND fallback_budget.remaining OPERATOR(pg_catalog.>) 0
        THEN GREATEST(
          fallback_budget.remaining,
          0::pg_catalog.int8
        )
      ELSE 0::pg_catalog.int8
    END
  ) AS fallback
),
combined AS (
  SELECT * FROM primary_rows
  UNION ALL
  SELECT * FROM fallback_rows
)
SELECT
  combined.summary_id,
  combined.conversation_id,
  combined.kind,
  combined.snippet,
  combined.rank,
  combined.created_at,
  combined.match_phase
FROM combined
ORDER BY
  combined.match_phase,
  combined.match_order DESC,
  combined.created_at DESC,
  combined.summary_id DESC
LIMIT $6::pg_catalog.int8`;

const SUMMARY_REGEX_SQL = `SELECT
  summary.summary_id,
  summary.conversation_id,
  summary.kind,
  pg_catalog.left(
    pg_catalog.regexp_substr(summary.content, $2::pg_catalog.text),
    512
  ) AS snippet,
  0::pg_catalog.float4 AS rank,
  summary.created_at
FROM lcm.summaries AS summary
WHERE summary.project_id OPERATOR(pg_catalog.=) $1::pg_catalog.uuid
  AND (
    $3::pg_catalog.int8 IS NULL
    OR summary.conversation_id OPERATOR(pg_catalog.=) $3::pg_catalog.int8
  )
  AND (
    $4::pg_catalog.timestamptz IS NULL
    OR summary.created_at OPERATOR(pg_catalog.>=) $4::pg_catalog.timestamptz
  )
  AND (
    $5::pg_catalog.timestamptz IS NULL
    OR summary.created_at OPERATOR(pg_catalog.<) $5::pg_catalog.timestamptz
  )
  AND summary.content OPERATOR(pg_catalog.~) $2::pg_catalog.text
ORDER BY summary.created_at DESC, summary.summary_id DESC
LIMIT $6::pg_catalog.int8`;

const PROMOTED_FULL_TEXT_SQL = `WITH input AS MATERIALIZED (
  SELECT
    normalized.query,
    pg_catalog.websearch_to_tsquery(
      'lcm.search_v1'::pg_catalog.regconfig,
      normalized.query
    ) AS full_text_query
  FROM (
    SELECT lcm.normalize_search_text($2::pg_catalog.text) AS query
  ) AS normalized
),
primary_rows AS MATERIALIZED (
  SELECT
    ranked.memory_id,
    ranked.content,
    COALESCE(
      (
        SELECT pg_catalog.array_agg(tag.tag ORDER BY tag.ordinal)
        FROM lcm.promoted_memory_tags AS tag
        WHERE tag.project_id OPERATOR(pg_catalog.=) $1::pg_catalog.uuid
          AND tag.memory_id OPERATOR(pg_catalog.=) ranked.memory_id
      ),
      '{}'::pg_catalog.text[]
    ) AS tags,
    ranked.source_project_id,
    ranked.session_id,
    ranked.confidence,
    ranked.created_at,
    OPERATOR(pg_catalog.-) ranked.relevance AS rank,
    0::pg_catalog.int2 AS match_phase,
    ranked.relevance AS match_order
  FROM (
    SELECT
      memory.memory_id,
      memory.content,
      memory.source_project_id,
      memory.session_id,
      memory.confidence,
      memory.created_at,
      GREATEST(
        pg_catalog.ts_rank_cd(
          memory.search_document,
          input.full_text_query
        ),
        COALESCE(
          (
            SELECT pg_catalog.max(
              pg_catalog.ts_rank_cd(
                tag.search_document,
                input.full_text_query
              )
            )
            FROM lcm.promoted_memory_tags AS tag
            WHERE tag.project_id OPERATOR(pg_catalog.=) memory.project_id
              AND tag.memory_id OPERATOR(pg_catalog.=) memory.memory_id
              AND tag.search_document
                OPERATOR(pg_catalog.@@) input.full_text_query
          ),
          0::pg_catalog.float4
        )
      ) AS relevance
    FROM lcm.promoted_memories AS memory
    CROSS JOIN input
    WHERE memory.project_id OPERATOR(pg_catalog.=) $1::pg_catalog.uuid
      AND memory.archived_at IS NULL
      AND (
        memory.search_document OPERATOR(pg_catalog.@@) input.full_text_query
        OR EXISTS (
          SELECT 1
          FROM lcm.promoted_memory_tags AS tag
          WHERE tag.project_id OPERATOR(pg_catalog.=) memory.project_id
            AND tag.memory_id OPERATOR(pg_catalog.=) memory.memory_id
            AND tag.search_document
              OPERATOR(pg_catalog.@@) input.full_text_query
        )
      )
      AND (
        $3::pg_catalog.text IS NULL
        OR memory.source_project_id OPERATOR(pg_catalog.=) $3::pg_catalog.text
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest($4::pg_catalog.text[]) AS required(tag)
        WHERE NOT EXISTS (
          SELECT 1
          FROM lcm.promoted_memory_tags AS actual
          WHERE actual.project_id OPERATOR(pg_catalog.=) memory.project_id
            AND actual.memory_id OPERATOR(pg_catalog.=) memory.memory_id
            AND actual.tag OPERATOR(pg_catalog.=) required.tag
        )
      )
  ) AS ranked
  WHERE ranked.relevance OPERATOR(pg_catalog.>) 0::pg_catalog.float4
  ORDER BY
    ranked.relevance DESC,
    ranked.created_at DESC,
    ranked.memory_id DESC
  LIMIT $5::pg_catalog.int8
),
fallback_budget AS MATERIALIZED (
  SELECT GREATEST(
           $5::pg_catalog.int8
             OPERATOR(pg_catalog.-)
             pg_catalog.count(*)::pg_catalog.int8,
           0::pg_catalog.int8
         ) AS remaining
  FROM primary_rows
),
fallback_rows AS MATERIALIZED (
  SELECT
    fallback.memory_id,
    fallback.content,
    fallback.tags,
    fallback.source_project_id,
    fallback.session_id,
    fallback.confidence,
    fallback.created_at,
    fallback.rank,
    1::pg_catalog.int2 AS match_phase,
    fallback.rank AS match_order
  FROM input
  CROSS JOIN fallback_budget
  CROSS JOIN LATERAL (
    SELECT
      ranked.memory_id,
      ranked.content,
      COALESCE(
        (
          SELECT pg_catalog.array_agg(tag.tag ORDER BY tag.ordinal)
          FROM lcm.promoted_memory_tags AS tag
          WHERE tag.project_id OPERATOR(pg_catalog.=) $1::pg_catalog.uuid
            AND tag.memory_id OPERATOR(pg_catalog.=) ranked.memory_id
        ),
        '{}'::pg_catalog.text[]
      ) AS tags,
      ranked.source_project_id,
      ranked.session_id,
      ranked.confidence,
      ranked.created_at,
      ranked.rank
    FROM (
      SELECT
        memory.memory_id,
        memory.content,
        memory.source_project_id,
        memory.session_id,
        memory.confidence,
        memory.created_at,
        GREATEST(
          public.similarity(
            lcm.normalize_search_text(memory.content),
            input.query
          ),
          COALESCE(
            (
              SELECT pg_catalog.max(
                public.similarity(
                  lcm.normalize_search_text(tag.tag),
                  input.query
                )
              )
              FROM lcm.promoted_memory_tags AS tag
              WHERE tag.project_id OPERATOR(pg_catalog.=) memory.project_id
                AND tag.memory_id OPERATOR(pg_catalog.=) memory.memory_id
            ),
            0::pg_catalog.float4
          )
        ) AS rank
      FROM lcm.promoted_memories AS memory
      WHERE pg_catalog.octet_length(input.query)
          OPERATOR(pg_catalog.>=) 3
        AND fallback_budget.remaining OPERATOR(pg_catalog.>) 0
        AND memory.project_id OPERATOR(pg_catalog.=) $1::pg_catalog.uuid
        AND memory.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM primary_rows AS primary_row
          WHERE primary_row.memory_id OPERATOR(pg_catalog.=) memory.memory_id
        )
        AND (
          lcm.normalize_search_text(memory.content)
            OPERATOR(public.%) input.query
          OR lcm.normalize_search_text(memory.content)
            OPERATOR(pg_catalog.~~)
            (
              '%' OPERATOR(pg_catalog.||)
              pg_catalog.replace(
                pg_catalog.replace(
                  pg_catalog.replace(input.query, E'\\\\', E'\\\\\\\\'),
                  '%',
                  E'\\\\%'
                ),
                '_',
                E'\\\\_'
              )
              OPERATOR(pg_catalog.||) '%'
            )
          OR EXISTS (
            SELECT 1
            FROM lcm.promoted_memory_tags AS tag
            WHERE tag.project_id OPERATOR(pg_catalog.=) memory.project_id
              AND tag.memory_id OPERATOR(pg_catalog.=) memory.memory_id
              AND (
                lcm.normalize_search_text(tag.tag)
                  OPERATOR(public.%) input.query
                OR lcm.normalize_search_text(tag.tag)
                  OPERATOR(pg_catalog.~~)
                  (
                    '%' OPERATOR(pg_catalog.||)
                    pg_catalog.replace(
                      pg_catalog.replace(
                        pg_catalog.replace(input.query, E'\\\\', E'\\\\\\\\'),
                        '%',
                        E'\\\\%'
                      ),
                      '_',
                      E'\\\\_'
                    )
                    OPERATOR(pg_catalog.||) '%'
                  )
              )
          )
        )
        AND (
          $3::pg_catalog.text IS NULL
          OR memory.source_project_id OPERATOR(pg_catalog.=)
            $3::pg_catalog.text
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest($4::pg_catalog.text[]) AS required(tag)
          WHERE NOT EXISTS (
            SELECT 1
            FROM lcm.promoted_memory_tags AS actual
            WHERE actual.project_id OPERATOR(pg_catalog.=) memory.project_id
              AND actual.memory_id OPERATOR(pg_catalog.=) memory.memory_id
              AND actual.tag OPERATOR(pg_catalog.=) required.tag
          )
        )
    ) AS ranked
    ORDER BY
      ranked.rank DESC,
      ranked.created_at DESC,
      ranked.memory_id DESC
    LIMIT CASE
      WHEN pg_catalog.octet_length(input.query)
          OPERATOR(pg_catalog.>=) 3
        AND fallback_budget.remaining OPERATOR(pg_catalog.>) 0
        THEN GREATEST(
          fallback_budget.remaining,
          0::pg_catalog.int8
        )
      ELSE 0::pg_catalog.int8
    END
  ) AS fallback
),
combined AS (
  SELECT * FROM primary_rows
  UNION ALL
  SELECT * FROM fallback_rows
)
SELECT
  combined.memory_id,
  combined.content,
  combined.tags,
  combined.source_project_id,
  combined.session_id,
  combined.confidence,
  combined.created_at,
  combined.rank,
  combined.match_phase
FROM combined
ORDER BY
  combined.match_phase,
  combined.match_order DESC,
  combined.created_at DESC,
  combined.memory_id DESC
LIMIT $5::pg_catalog.int8`;

export class PostgreSqlLexicalSearchRepository
  implements LexicalSearchRepository
{
  private readonly access: RepositoryAccess;

  constructor(executor: RepositoryExecutor, projectId: string) {
    this.access = new RepositoryAccess(executor, projectId);
  }

  async searchMessages(
    input: MessageSearchInput
  ): Promise<MessageSearchResult[]> {
    const operation = "searchMessages";
    const snapshot = snapshotInput(input, this.access.projectId, operation);
    if (
      snapshot.limit === 0 ||
      snapshot.query.trim().length === 0 ||
      (snapshot.mode === "full_text" && normalizesToEmpty(snapshot.query))
    ) {
      return [];
    }
    return this.access.atomic(operation, async (executor) => {
      const context = this.access.context(operation);
      if (snapshot.mode === "regex") {
        return await withBoundedSearch(executor, context, async () => {
          const result = await executor.query<MessageSearchRow>(
            {
              text: MESSAGE_REGEX_SQL,
              values: [
                this.access.projectId,
                snapshot.query,
                snapshot.conversationId,
                snapshot.since,
                snapshot.before,
                snapshot.limit,
              ],
            },
            context
          );
          return result.rows.map((row) =>
            messageFromRow(row, this.access.projectId, operation)
          );
        });
      }
      return withBoundedSearch(executor, context, async () => {
        const result = await executor.query<CombinedMessageSearchRow>(
          {
            text: MESSAGE_FULL_TEXT_SQL,
            values: [
              this.access.projectId,
              snapshot.query,
              snapshot.conversationId,
              snapshot.since,
              snapshot.before,
              snapshot.limit,
            ],
          },
          context
        );
        return decodeCombinedRows(
          result.rows,
          this.access.projectId,
          operation,
          (row) => messageFromRow(row, this.access.projectId, operation),
          (row) => row.messageId,
          snapshot.limit
        );
      });
    });
  }

  async searchSummaries(
    input: SummarySearchInput
  ): Promise<SummarySearchResult[]> {
    const operation = "searchSummaries";
    const snapshot = snapshotInput(input, this.access.projectId, operation);
    if (
      snapshot.limit === 0 ||
      snapshot.query.trim().length === 0 ||
      (snapshot.mode === "full_text" && normalizesToEmpty(snapshot.query))
    ) {
      return [];
    }
    return this.access.atomic(operation, async (executor) => {
      const context = this.access.context(operation);
      if (snapshot.mode === "regex") {
        return await withBoundedSearch(executor, context, async () => {
          const result = await executor.query<SummarySearchRow>(
            {
              text: SUMMARY_REGEX_SQL,
              values: [
                this.access.projectId,
                snapshot.query,
                snapshot.conversationId,
                snapshot.since,
                snapshot.before,
                snapshot.limit,
              ],
            },
            context
          );
          return result.rows.map((row) =>
            summaryFromRow(row, this.access.projectId, operation)
          );
        });
      }
      return withBoundedSearch(executor, context, async () => {
        const result = await executor.query<CombinedSummarySearchRow>(
          {
            text: SUMMARY_FULL_TEXT_SQL,
            values: [
              this.access.projectId,
              snapshot.query,
              snapshot.conversationId,
              snapshot.since,
              snapshot.before,
              snapshot.limit,
            ],
          },
          context
        );
        return decodeCombinedRows(
          result.rows,
          this.access.projectId,
          operation,
          (row) => summaryFromRow(row, this.access.projectId, operation),
          (row) => row.summaryId,
          snapshot.limit
        );
      });
    });
  }

  async searchPromoted(
    queryInput: string,
    limitInput: number,
    filterTagsInput: string[] = [],
    sourceProjectIdInput?: string
  ): Promise<SearchResult[]> {
    const operation = "searchPromoted";
    const query = validatedString(
      queryInput,
      this.access.projectId,
      operation,
      "query"
    );
    const limit = searchLimit(limitInput, this.access.projectId, operation);
    const filterTags = tags(
      filterTagsInput,
      this.access.projectId,
      operation,
      "filter_tags"
    );
    const sourceProjectId =
      sourceProjectIdInput === undefined
        ? null
        : validatedString(
            sourceProjectIdInput,
            this.access.projectId,
            operation,
            "source_project_id"
          );
    if (limit === 0 || query.trim().length === 0 || normalizesToEmpty(query)) {
      return [];
    }
    return this.access.atomic(operation, async (executor) => {
      const context = this.access.context(operation);
      return withBoundedSearch(executor, context, async () => {
        const result = await executor.query<CombinedPromotedSearchRow>(
          {
            text: PROMOTED_FULL_TEXT_SQL,
            values: [
              this.access.projectId,
              query,
              sourceProjectId,
              filterTags,
              limit,
            ],
          },
          context
        );
        return decodeCombinedRows(
          result.rows,
          this.access.projectId,
          operation,
          (row, phase) =>
            promotedFromRow(row, this.access.projectId, operation, phase),
          (row) => row.id,
          limit
        );
      });
    });
  }
}
