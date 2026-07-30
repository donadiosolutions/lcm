# PostgreSQL lexical search

Issue #89 adds a staged PostgreSQL 18 lexical-search repository for messages,
summaries, promoted memories, and promoted-memory tags. It implements the
existing `LexicalSearchRepository` result shapes and backend-neutral golden
fixtures. SQLite remains the active daemon and CLI backend: this adapter is
available for explicit repository use and conformance, but #92 and #224 still
own application cutover.

## Query modes and syntax

Message and summary searches accept `full_text` or `regex` mode. Promoted
memory uses full-text search with trigram fill.

- Full-text input is normalized by the pinned
  `lcm.normalize_search_text(text)` function and parsed with
  `websearch_to_tsquery('lcm.search_v1', ...)`. Ordinary words are combined
  using web-search syntax. Quoted phrases require adjacent terms, `OR` selects
  alternatives, and a leading minus excludes a term. PostgreSQL's web-search
  parser does not raise syntax errors for user input.
- Primary matches use each row's generated `search_document` and
  `ts_rank_cd`. Promoted-memory search considers both content and tags, so a
  tag-only match is valid.
- If primary matches do not fill the requested limit, a normalized
  `pg_trgm` substring/similarity query fills only the remaining slots.
  Previously selected IDs are excluded in SQL and deduplicated again at the
  result boundary. Queries shorter than three UTF-8 bytes do not run the
  trigram path.
- Regex input is checked by LCM's safe-regex validator before PostgreSQL I/O.
  Accepted patterns use PostgreSQL's regular-expression operator. Invalid or
  potentially catastrophic patterns fail with a sanitized lexical-search data
  error.
- An empty or whitespace-only query returns no rows without opening a
  transaction. Punctuation, quotes, percent signs, underscores, backslashes,
  and SQL-shaped text remain bound values; they are never interpolated as SQL.
  Such text can still contain legitimate searchable words, so zero matches are
  not guaranteed.

PostgreSQL and SQLite do not expose numerically comparable relevance scores.
Callers may use rank only within one backend response. PostgreSQL orders
full-text and trigram matches by descending rank, descending creation time,
and the final public ID. Regex results use descending creation time and ID.
Primary full-text results always precede trigram fill results. Repeating a
query against unchanged data therefore produces the same order.

## Scopes, limits, and snippets

Every query includes the repository's exact owner project. Optional
conversation, inclusive `since`, and exclusive `before` filters are applied in
SQL to message and summary searches. Promoted-memory rows must be active and
can be restricted by exact, case-sensitive required tags and exact
`source_project_id`; every required tag must exist before ranking and limiting.

The default message and summary limit is 50. Limits must be safe nonnegative
integers from 0 through 1,000; zero returns no rows. Promoted-memory callers
must provide a limit in the same range. Full-text headlines use empty
highlight markers, at most 32 words, and one fragment. Every message and
summary snippet is additionally bounded to 512 PostgreSQL characters. Regex
snippets contain the first matching text, while trigram snippets contain a
bounded content prefix.

Invalid dates, identifiers, modes, limits, unsupported Unicode strings,
malformed result rows, and invalid regex patterns become sanitized
`PostgreSqlLexicalSearchDataError` values. Error JSON identifies only the
backend, project, domain, operation, and invalid field; it does not echo query
text or returned content.

## Normalization and oversized lexemes

The released issue #83 schema owns normalization and indexing. Search reuses,
and does not duplicate or replace:

- PostgreSQL 18's `lcm.search_v1` text-search configuration;
- the fingerprinted, unaccent-derived
  `lcm.normalize_search_text(text)` function;
- stored generated `search_document` columns; and
- the eight full-text and normalized-trigram GIN indexes.

Normalization performs PostgreSQL 18 Unicode fast lowercase mapping and the
pinned PostgreSQL 18.4 `unaccent.rules` substitutions. Canonical source content
and exact promoted tags remain unchanged.

PostgreSQL omits a parsed full-text lexeme whose normalized UTF-8 length reaches
2,047 bytes. The harness proves that a 2,046-byte normalized lexeme is accepted
by full-text search and that a 2,047-byte lexeme produces an empty `tsvector`
entry. The repository does not truncate or reject canonical content: the
2,047-byte query is retrieved losslessly by the bounded trigram fill path.

## Timeout and transaction behavior

Regex and trigram statements run with the smaller of the connection's current
finite `statement_timeout` and five seconds. A connection configured with
unlimited timeout therefore receives the five-second search cap. The
repository reads the prior setting, changes it with transaction-local
`set_config`, and restores the exact prior value after successful work.

Standalone searches run in a repository transaction, so rollback or commit
removes transaction-local state before the connection returns to its pool.
When a caller supplies an active PostgreSQL transaction, the repository
serializes access and opens a savepoint. SQLSTATE `57014` rolls back and
releases only that savepoint; the caller's prior timeout and usable transaction
are preserved. A timeout never returns partial primary results, starts another
fallback, or broadens the query.

## Runtime privileges

Apply the dedicated grant script as the migration/schema owner:

```bash
psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file=docs/postgresql-runtime-search-grants.sql
```

Replace `lcm_runtime` with the existing runtime role. The script grants schema
`USAGE`, exact execution of the normalization function, and `SELECT` on only
messages, summaries, promoted memories, and promoted tags. It grants no schema
creation, conversation access, DML, sequence access, `TRUNCATE`, ownership,
grant option, or unrelated-domain access. Applying it does not activate
PostgreSQL daemon or CLI routing.

## Indexes, plans, and benchmark evidence

Search requires the already-managed `pg_trgm` and `unaccent` extensions and
these existing indexes:

| Domain           | Full-text index                            | Trigram index                        |
| ---------------- | ------------------------------------------ | ------------------------------------ |
| Messages         | `messages_search_document_idx`             | `messages_content_trgm_idx`          |
| Summaries        | `summaries_search_document_idx`            | `summaries_content_trgm_idx`         |
| Promoted content | `promoted_memories_search_document_idx`    | `promoted_memories_content_trgm_idx` |
| Promoted tags    | `promoted_memory_tags_search_document_idx` | `promoted_memory_tags_tag_trgm_idx`  |

The PostgreSQL 18 integration corpus inserts 4,000 rows in each domain, runs
`VACUUM (ANALYZE)` to flush GIN pending lists and refresh statistics, and uses
the default planner for selective full-text and substring predicates. All
eight plans must contain their intended bitmap GIN index. The test emits
corpus size plus JSON `EXPLAIN (ANALYZE, BUFFERS, TIMING FALSE)` evidence.
Execution time is diagnostic evidence, not a brittle admission threshold.

For an operator check, refresh statistics before interpreting a plan:

```sql
VACUUM (ANALYZE) lcm.messages;

EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING FALSE)
SELECT message_id
FROM lcm.messages
WHERE search_document @@
  websearch_to_tsquery('lcm.search_v1', 'diagnostic phrase');

EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING FALSE)
SELECT message_id
FROM lcm.messages
WHERE lcm.normalize_search_text(content) LIKE '%diagnostic phrase%';
```

A sequential scan on a tiny or unselective corpus can be the correct default
plan. On representative selective data, first confirm current statistics and a
flushed GIN pending list, then verify migration/search-configuration health,
extension namespace/version readiness, the exact indexed expression, project
and filter selectivity, and the eight index names above. Do not disable
sequential scans to manufacture production evidence.

Run `npm run test:postgresql` for the isolated PostgreSQL 18 proof. The harness
also verifies denied-before-grant behavior, exact least privilege, project
isolation, safe query binding, pool and caller-transaction recovery after
timeout, and exact run-scoped Docker cleanup.
