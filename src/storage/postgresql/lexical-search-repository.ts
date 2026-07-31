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
const MIN_TRIGRAM_QUERY_BYTES = 3;
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
      input.limit ?? DEFAULT_SEARCH_LIMIT,
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
  const result = [...primary];
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

function hasTrigrams(query: string): boolean {
  return Buffer.byteLength(query.trim(), "utf8") >= MIN_TRIGRAM_QUERY_BYTES;
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

const MESSAGE_PRIMARY_SQL = `WITH input AS (
  SELECT pg_catalog.websearch_to_tsquery(
           'lcm.search_v1'::pg_catalog.regconfig,
           lcm.normalize_search_text($2::pg_catalog.text)
         ) AS query
)
SELECT
  message.message_id,
  message.conversation_id,
  message.role,
  pg_catalog.left(
    pg_catalog.ts_headline(
      'lcm.search_v1'::pg_catalog.regconfig,
      lcm.normalize_search_text(message.content),
      input.query,
      'StartSel=, StopSel=, MaxWords=32, MinWords=8, ShortWord=1, MaxFragments=1, FragmentDelimiter= … '
    ),
    512
  ) AS snippet,
  pg_catalog.ts_rank_cd(message.search_document, input.query) AS rank,
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
    OR message.created_at OPERATOR(pg_catalog.>=) $4::pg_catalog.timestamptz
  )
  AND (
    $5::pg_catalog.timestamptz IS NULL
    OR message.created_at OPERATOR(pg_catalog.<) $5::pg_catalog.timestamptz
  )
  AND message.search_document OPERATOR(pg_catalog.@@) input.query
ORDER BY rank DESC, message.created_at DESC, message.message_id DESC
LIMIT $6::pg_catalog.int8`;

const MESSAGE_TRIGRAM_SQL = `WITH input AS (
  SELECT lcm.normalize_search_text($2::pg_catalog.text) AS query
),
candidate AS (
  SELECT
    message.message_id,
    message.conversation_id,
    message.role,
    message.content,
    message.created_at,
    lcm.normalize_search_text(message.content) AS normalized_content,
    input.query
  FROM lcm.messages AS message
  CROSS JOIN input
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
    AND NOT (
      message.message_id OPERATOR(pg_catalog.=)
      ANY($6::pg_catalog.int8[])
    )
    AND pg_catalog.octet_length(input.query)
      OPERATOR(pg_catalog.>=) 3
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
)
SELECT
  candidate.message_id,
  candidate.conversation_id,
  candidate.role,
  pg_catalog.left(candidate.content, 512) AS snippet,
  GREATEST(
    public.similarity(candidate.normalized_content, candidate.query),
    CASE
      WHEN candidate.normalized_content
        OPERATOR(pg_catalog.~~)
        (
          '%' OPERATOR(pg_catalog.||)
          pg_catalog.replace(
            pg_catalog.replace(
              pg_catalog.replace(candidate.query, E'\\\\', E'\\\\\\\\'),
              '%',
              E'\\\\%'
            ),
            '_',
            E'\\\\_'
          )
          OPERATOR(pg_catalog.||) '%'
        )
        THEN 1::pg_catalog.float4
      ELSE 0::pg_catalog.float4
    END
  ) AS rank,
  candidate.created_at
FROM candidate
ORDER BY rank DESC, candidate.created_at DESC, candidate.message_id DESC
LIMIT $7::pg_catalog.int8`;

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

const SUMMARY_PRIMARY_SQL = `WITH input AS (
  SELECT pg_catalog.websearch_to_tsquery(
           'lcm.search_v1'::pg_catalog.regconfig,
           lcm.normalize_search_text($2::pg_catalog.text)
         ) AS query
)
SELECT
  summary.summary_id,
  summary.conversation_id,
  summary.kind,
  pg_catalog.left(
    pg_catalog.ts_headline(
      'lcm.search_v1'::pg_catalog.regconfig,
      lcm.normalize_search_text(summary.content),
      input.query,
      'StartSel=, StopSel=, MaxWords=32, MinWords=8, ShortWord=1, MaxFragments=1, FragmentDelimiter= … '
    ),
    512
  ) AS snippet,
  pg_catalog.ts_rank_cd(summary.search_document, input.query) AS rank,
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
    OR summary.created_at OPERATOR(pg_catalog.>=) $4::pg_catalog.timestamptz
  )
  AND (
    $5::pg_catalog.timestamptz IS NULL
    OR summary.created_at OPERATOR(pg_catalog.<) $5::pg_catalog.timestamptz
  )
  AND summary.search_document OPERATOR(pg_catalog.@@) input.query
ORDER BY rank DESC, summary.created_at DESC, summary.summary_id DESC
LIMIT $6::pg_catalog.int8`;

const SUMMARY_TRIGRAM_SQL = `WITH input AS (
  SELECT lcm.normalize_search_text($2::pg_catalog.text) AS query
),
candidate AS (
  SELECT
    summary.summary_id,
    summary.conversation_id,
    summary.kind,
    summary.content,
    summary.created_at,
    lcm.normalize_search_text(summary.content) AS normalized_content,
    input.query
  FROM lcm.summaries AS summary
  CROSS JOIN input
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
    AND NOT (
      summary.summary_id OPERATOR(pg_catalog.=)
      ANY($6::pg_catalog.text[])
    )
    AND pg_catalog.octet_length(input.query)
      OPERATOR(pg_catalog.>=) 3
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
)
SELECT
  candidate.summary_id,
  candidate.conversation_id,
  candidate.kind,
  pg_catalog.left(candidate.content, 512) AS snippet,
  GREATEST(
    public.similarity(candidate.normalized_content, candidate.query),
    CASE
      WHEN candidate.normalized_content
        OPERATOR(pg_catalog.~~)
        (
          '%' OPERATOR(pg_catalog.||)
          pg_catalog.replace(
            pg_catalog.replace(
              pg_catalog.replace(candidate.query, E'\\\\', E'\\\\\\\\'),
              '%',
              E'\\\\%'
            ),
            '_',
            E'\\\\_'
          )
          OPERATOR(pg_catalog.||) '%'
        )
        THEN 1::pg_catalog.float4
      ELSE 0::pg_catalog.float4
    END
  ) AS rank,
  candidate.created_at
FROM candidate
ORDER BY rank DESC, candidate.created_at DESC, candidate.summary_id DESC
LIMIT $7::pg_catalog.int8`;

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

const PROMOTED_PRIMARY_SQL = `WITH input AS (
  SELECT pg_catalog.websearch_to_tsquery(
           'lcm.search_v1'::pg_catalog.regconfig,
           lcm.normalize_search_text($2::pg_catalog.text)
         ) AS query
),
ranked AS (
  SELECT
    memory.memory_id,
    memory.content,
    memory.source_project_id,
    memory.session_id,
    memory.confidence,
    memory.created_at,
    GREATEST(
      pg_catalog.ts_rank_cd(memory.search_document, input.query),
      COALESCE(
        (
          SELECT pg_catalog.max(
            pg_catalog.ts_rank_cd(tag.search_document, input.query)
          )
          FROM lcm.promoted_memory_tags AS tag
          WHERE tag.project_id OPERATOR(pg_catalog.=) memory.project_id
            AND tag.memory_id OPERATOR(pg_catalog.=) memory.memory_id
            AND tag.search_document OPERATOR(pg_catalog.@@) input.query
        ),
        0::pg_catalog.float4
      )
    ) AS relevance
  FROM lcm.promoted_memories AS memory
  CROSS JOIN input
  WHERE memory.project_id OPERATOR(pg_catalog.=) $1::pg_catalog.uuid
    AND memory.archived_at IS NULL
    AND (
      memory.search_document OPERATOR(pg_catalog.@@) input.query
      OR EXISTS (
        SELECT 1
        FROM lcm.promoted_memory_tags AS tag
        WHERE tag.project_id OPERATOR(pg_catalog.=) memory.project_id
          AND tag.memory_id OPERATOR(pg_catalog.=) memory.memory_id
          AND tag.search_document OPERATOR(pg_catalog.@@) input.query
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
)
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
  OPERATOR(pg_catalog.-) ranked.relevance AS rank
FROM ranked
WHERE ranked.relevance OPERATOR(pg_catalog.>) 0::pg_catalog.float4
ORDER BY
  ranked.relevance DESC,
  ranked.created_at DESC,
  ranked.memory_id DESC
LIMIT $5::pg_catalog.int8`;

const PROMOTED_TRIGRAM_SQL = `WITH input AS (
  SELECT lcm.normalize_search_text($2::pg_catalog.text) AS query
),
ranked AS (
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
  CROSS JOIN input
  WHERE memory.project_id OPERATOR(pg_catalog.=) $1::pg_catalog.uuid
    AND memory.archived_at IS NULL
    AND NOT (
      memory.memory_id OPERATOR(pg_catalog.=)
      ANY($3::pg_catalog.uuid[])
    )
    AND pg_catalog.octet_length(input.query)
      OPERATOR(pg_catalog.>=) 3
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
      $4::pg_catalog.text IS NULL
      OR memory.source_project_id OPERATOR(pg_catalog.=) $4::pg_catalog.text
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.unnest($5::pg_catalog.text[]) AS required(tag)
      WHERE NOT EXISTS (
        SELECT 1
        FROM lcm.promoted_memory_tags AS actual
        WHERE actual.project_id OPERATOR(pg_catalog.=) memory.project_id
          AND actual.memory_id OPERATOR(pg_catalog.=) memory.memory_id
          AND actual.tag OPERATOR(pg_catalog.=) required.tag
      )
    )
)
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
FROM ranked
ORDER BY
  ranked.rank DESC,
  ranked.created_at DESC,
  ranked.memory_id DESC
LIMIT $6::pg_catalog.int8`;

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
      const primary = await executor.query<MessageSearchRow>(
        {
          text: MESSAGE_PRIMARY_SQL,
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
      const primaryResults = primary.rows.map((row) =>
        messageFromRow(row, this.access.projectId, operation)
      );
      if (
        primaryResults.length >= snapshot.limit ||
        !hasTrigrams(snapshot.query)
      ) {
        return primaryResults;
      }
      return withBoundedSearch(executor, context, async () => {
        const fallback = await executor.query<MessageSearchRow>(
          {
            text: MESSAGE_TRIGRAM_SQL,
            values: [
              this.access.projectId,
              snapshot.query,
              snapshot.conversationId,
              snapshot.since,
              snapshot.before,
              primaryResults.map((row) => row.messageId),
              snapshot.limit - primaryResults.length,
            ],
          },
          context
        );
        return appendDeduplicated(
          primaryResults,
          fallback.rows.map((row) =>
            messageFromRow(row, this.access.projectId, operation)
          ),
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
      const primary = await executor.query<SummarySearchRow>(
        {
          text: SUMMARY_PRIMARY_SQL,
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
      const primaryResults = primary.rows.map((row) =>
        summaryFromRow(row, this.access.projectId, operation)
      );
      if (
        primaryResults.length >= snapshot.limit ||
        !hasTrigrams(snapshot.query)
      ) {
        return primaryResults;
      }
      return withBoundedSearch(executor, context, async () => {
        const fallback = await executor.query<SummarySearchRow>(
          {
            text: SUMMARY_TRIGRAM_SQL,
            values: [
              this.access.projectId,
              snapshot.query,
              snapshot.conversationId,
              snapshot.since,
              snapshot.before,
              primaryResults.map((row) => row.summaryId),
              snapshot.limit - primaryResults.length,
            ],
          },
          context
        );
        return appendDeduplicated(
          primaryResults,
          fallback.rows.map((row) =>
            summaryFromRow(row, this.access.projectId, operation)
          ),
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
      const primary = await executor.query<PromotedSearchRow>(
        {
          text: PROMOTED_PRIMARY_SQL,
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
      const primaryResults = primary.rows.map((row) =>
        promotedFromRow(row, this.access.projectId, operation, "primary")
      );
      if (primaryResults.length >= limit || !hasTrigrams(query)) {
        return primaryResults;
      }
      return withBoundedSearch(executor, context, async () => {
        const fallback = await executor.query<PromotedSearchRow>(
          {
            text: PROMOTED_TRIGRAM_SQL,
            values: [
              this.access.projectId,
              query,
              primaryResults.map((row) => row.id),
              sourceProjectId,
              filterTags,
              limit - primaryResults.length,
            ],
          },
          context
        );
        return appendDeduplicated(
          primaryResults,
          fallback.rows.map((row) =>
            promotedFromRow(row, this.access.projectId, operation, "fallback")
          ),
          (row) => row.id,
          limit
        );
      });
    });
  }
}
