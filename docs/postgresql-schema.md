# PostgreSQL 18 schema reference

This reference describes the durable PostgreSQL baseline introduced by
`0001_migration_ledger.sql` and `0002_schema_baseline.sql`. The latter creates
23 domain tables, backend-neutral project identity, and bounded session lookup
keys. This is a schema and readiness contract, not an enabled
application backend. SQLite remains the authoritative production adapter.
PostgreSQL machine and project identity operations are enabled by issue #84.
The conversation, message, and message-part adapter added by issue #85 is
available for repository conformance but is not routed through the daemon or
CLI. The native-transcript adapter added by issue #86 is available to explicit
programmatic backfill and repository conformance under the same staged
boundary. Managed daemons may start with PostgreSQL selected so identity
operations are available, but storage-backed health, status, statistics, and
data routes remain fail-closed until the remaining domain repositories pass
conformance, issue #92 enables the backend, and issue #224 activates normal
daemon/CLI transcript routing.

The design is single-user and multi-machine. Project scoping prevents accidental
cross-project relationships; it is not a tenant or authorization boundary and
does not add row-level security.

## Schema-wide rules

- All application objects live in `lcm`. The migrator owns the schema and its
  objects. An absent schema is created by the migration role. A pre-existing
  schema must already be owned by that same role; a delegated `CREATE` grant is
  insufficient and fails the ownership preflight without changing the schema.
  A supported `lcm` schema must also not grant `CREATE` to `PUBLIC`; every
  migration run checks the exact catalog ACL under the advisory lock before
  ledger inspection. The same catalog-only phase verifies ownership of every
  existing allowlisted LCM object, including the migration ledger, before any
  ledger row is read; baseline completeness is checked after the applied
  history is known. The immutable baseline repeats the ACL defense before its
  owned DDL. Either check aborts without changing the schema ACL. The baseline revokes
  privileges from `PUBLIC` on an explicit list of the 23 domain tables, the
  migration ledger, six generated identity sequences, and
  `lcm.normalize_search_text(text)` plus the summary-, large-file-, and
  session-ingest-identity trigger functions.
  It deliberately grants no domain access to the runtime role by default.
  Administrators grant only the exact operations required by each enabled
  repository; issue #84 grants the machine and project identity operations
  described below. Explicit object lists keep privileges on unknown
  pre-existing tables, sequences, and functions intact.
- Before starting the DDL transaction, migration requires
  `pg_catalog.current_setting('server_encoding')` to return exactly `UTF8`.
  Runtime health enforces the same database-encoding contract before extension
  or search-fingerprint inspection. Missing, malformed, or non-UTF-8 values
  produce sanitized restore/recreation guidance; LCM never mutates database
  encoding.
- The migration runner captures the postmaster epoch and completes required
  extension readiness, including the functional `pg_stat_statements` probe,
  before opening the DDL transaction. Inside that transaction it pins the local
  `search_path` to `pg_catalog, public` and `quote_all_identifiers` to `off`
  before taking the advisory lock. Pinning the deparser setting makes every
  `pg_get_*` fingerprint independent of role or database defaults. The runner
  then checks PostgreSQL 18 and postmaster/module continuity, revalidates the exact
  extension catalog snapshot without repeating the functional probe, checking
  schema ownership and `PUBLIC CREATE`, then checking ownership of every
  existing allowlisted object before reading the exact ordered ledger. Only
  after the ledger is trusted does the runner require the complete
  managed-object inventory from the selected current snapshot; any missing
  allowlisted object then fails readiness instead of being mistaken for a
  smaller valid inventory. After pending SQL and ledger rows, the selected
  target snapshot's managed inventory is checked again before commit.
  The recurring allowlist covers the
  migration ledger, 23 domain tables, six generated identity sequences, four
  helper or trigger functions, and the LCM text-search dictionary and
  configuration. Unknown `lcm` objects are ignored and never mutated. This makes
  unqualified PostgreSQL built-ins in the immutable migrations resolve to native
  catalog objects while retaining intentional access to extension objects in
  `public`; the setting reverts on either commit or rollback. Extension
  inspection also schema-qualifies every catalog operator because it runs
  outside that migration transaction and runtime health uses the same
  inspection path.
- Managed-object identities, definition fingerprints, and function
  fingerprints are registered by migration ID.
  Before pending SQL, the runner walks the trusted ledger from newest to oldest
  and checks the first migration with a registered snapshot. After applying and
  recording the pending set, it does the same for the target history in the
  same transaction; failure rolls back both DDL and ledger rows. Registry
  declaration order does not affect selection. A future migration can
  therefore add its own snapshot without requiring the pre-upgrade schema to
  satisfy the future definition. Before catalog access, the registry rejects
  duplicate snapshot migration IDs and IDs absent from the supplied migration
  history.
- The `0002` snapshot checks an explicit definition inventory of all 52 named
  secondary indexes, all 168 table constraints, all three identity-enforcement
  triggers, all 15 stored generated columns, all six generated identity
  sequences, all 24 permanent tables, the complete effective ACLs of those
  tables and six sequences, all 205 ordinary columns, and the exact effective
  column ACL state of all 220 ordinary and generated columns: 723 definitions
  total. The ordinary-column allowlist includes
  `recall_surfacing.surfaced_at`, and a live-catalog regression requires the
  allowlist to equal the complete ordinary-column inventory of the 24 tables.
  Each allowlisted object must exist, every index must
  remain valid and ready, and canonical index, trigger, fully qualified
  constraint, generation-expression, and ordinary-column definitions must
  retain their pinned fingerprints. Trigger fingerprints include the
  enablement mode and require
  always-enabled mode (`A`), so the identity checks cannot be bypassed by
  `session_replication_role = replica`; disabled, ordinary, or replica-only
  drift fails readiness. Constraint fingerprints bind the constraint name
  to its owning table, type, fully qualified definition, and stable
  enablement-state multiset of their zero or more internal enforcement
  triggers. Generated-column fingerprints bind the exact table, column,
  formatted type, nullability, `attgenerated` state, PostgreSQL-deparsed
  expression, and resolved
  namespace-qualified collation. Ordinary-column
  fingerprints bind the exact table and column to its formatted type,
  nullability, deparsed default, identity state, and resolved
  namespace-qualified collation. Table fingerprints require ordinary permanent
  persistence with row-level security disabled and not forced, so `UNLOGGED`,
  temporary, `ENABLE ROW LEVEL SECURITY`, or `FORCE ROW LEVEL SECURITY` drift
  fails closed. The same fingerprint rejects any inheritance or partition
  parent/child relationship involving a managed table. Relation ACL
  fingerprints expand the effective ACL, including PostgreSQL's default ACL
  when `relacl` is null. They normalize the owning role and exact non-grantable
  identity- and conversation-repository privilege shapes granted to named
  runtime roles by the documented scripts. Any `PUBLIC`, grantable,
  foreign-grantor, missing-owner, or privilege outside that allowlist on an
  allowlisted table or identity sequence therefore fails closed.
  Column ACL fingerprints retain every allowlisted column even when `attacl`
  is null and expand every explicit entry. They normalize only the script's
  exact insert and update column-grant shapes for named runtime roles; any
  `PUBLIC`, foreign-grantor, grantable, or out-of-allowlist privilege on a
  column therefore also fails closed.
  Identity-sequence
  fingerprints bind each exact sequence name to its PostgreSQL data type,
  increment, minimum, maximum, start, cache, cycle state, internal identity
  dependency, owning table/column, and permanent persistence. `SET UNLOGGED`
  drift therefore fails closed. Index ownership
  follows the owning table; triggers and constraints are checked as existence
  and definition inventory.
  Additional operator-created objects remain outside the allowlist and are
  ignored.
- Recurring migration readiness fingerprints the bodies and security
  configuration of `lcm.enforce_summary_id_uniqueness()` and
  `lcm.enforce_large_file_id_uniqueness()`, and
  `lcm.enforce_session_ingest_id_uniqueness()`. The check covers the stored
  body, language and trigger return type, invoker/security and leakproof flags,
  volatility, parallel safety, fixed `search_path`, and the complete normalized
  function ACL. Only non-grantable `EXECUTE` by the owning role is accepted;
  `PUBLIC`, named-role, grant-option, foreign-grantor, missing-owner, and other
  ACL drift therefore fail closed even when the function name and arity still
  match. The snapshot owns the complete helper-name and body-hash lists,
  including their count, so later migrations can add or remove helpers without
  changing the verifier SQL.
- PostgreSQL 18's native [`uuidv7()`](https://www.postgresql.org/docs/18/functions-uuid.html)
  is the default for machine, project, part, transcript, promoted-memory, and
  internal summary relationship identities. Machine, project,
  native-transcript, and summary relationship keys enforce UUID version 7; the
  other UUID-derived tables permit an explicit UUID during
  SQLite import/backfill while still generating UUIDv7 for new rows. Summary
  and large-file IDs are caller-supplied text because the shared repository
  contracts use values such as `sum_<16 hex>` and `file_<16 hex>` and permit
  arbitrary string identifiers; omitted IDs still receive a UUIDv7 rendered as
  text. Exact unbounded summary IDs are resolved through a fixed-width SHA-256
  candidate index plus a full-text residual comparison; a UUIDv7
  `summary_key` carries every B-tree identity, order, and relationship so the
  caller ID never enters an index tuple. A transaction advisory lock on the
  project/hash candidate plus the residual comparison enforces exact
  project-scoped uniqueness without treating a theoretical hash collision as
  identity. Large files use the same pattern: `file_key` carries bounded
  identity and ordering, while `file_id_sha256` narrows exact caller-ID lookup.
  Opaque summary file references retain their original `file_id` text and a
  generated digest candidate without gaining a local-file foreign key.
  Caller-owned session identifiers use the same collision-safe lookup shape:
  exact text remains canonical, while generated SHA-256 candidates carry every
  B-tree lookup for conversations, native transcripts, recall surfacing, and
  ingest completion. Queries retain the exact text predicate as the residual.
  Session-ingest rows use an internal UUIDv7 `ingest_key`; a transaction
  advisory lock plus digest candidate and exact residual preserves exact
  per-project uniqueness without indexing arbitrary-length session text. These
  advisory-locked exact-identity triggers require `READ COMMITTED` isolation,
  where the residual query can observe a preceding lock holder's commit. They
  fail closed with SQLSTATE `0A000` under `REPEATABLE READ` or `SERIALIZABLE`
  instead of trusting a transaction-wide stale snapshot.
  Conversations and messages retain generated `bigint` identities compatible
  with the existing repository contracts. Inbox, recall, and instruction rows
  also use generated numeric identities where a local ordering key is useful.
  Fencing tokens use a database-owned, generated-always `bigint` identity
  sequence. Its global allocation is stronger than per-resource monotonicity:
  deleting a released or expired lease row does not reset the allocator, so a
  later lease cannot receive a previously generated token.
- Timestamps use `timestamptz` and default to `statement_timestamp()`. Checks
  reject reversed lifecycle ranges. Counters, ordinals, token counts, byte
  counts and depths are nonnegative; step costs are finite and nonnegative;
  fencing tokens and event versions are strictly positive.
- Composite foreign keys carry `project_id` and, for conversation data,
  `conversation_id`. They make cross-project and cross-conversation links
  impossible even when a globally unique row ID is known.
- JSONB is limited to client-native payloads, promoted-memory metadata,
  checkpoint state, and passive-event envelopes. Message-part metadata remains
  opaque nullable text so every backend can preserve caller formatting and even
  non-JSON values exactly. Native payloads are objects or arrays, and all other
  JSONB values are objects. Queryable tags, state, counters, identities, and
  relationships remain normalized columns or relations.
- `lcm.normalize_search_text(text)` lowercases with PostgreSQL 18's builtin
  `pg_unicode_fast` collation and applies an embedded copy of
  PostgreSQL 18.4's 2,661 `unaccent.rules` mappings. The source rule file is
  pinned by SHA-256
  `ecf4c41c0883dee17d02431e0a7f24a2611aadf8fe1da06e98c6ccb4acc4a981`;
  its canonical embedded JSON is pinned by SHA-256
  `21d9c6e1f20f37d7d804b81dc7f62372b68de9ff05037d5f4f3c85cef4868588`.
  The migration artifact checksum protects both. The immutable, parallel-safe
  function has no dependency on the mutable extension dictionary or the
  database's libc/ICU collation provider. `pg_unicode_fast` uses PostgreSQL's
  bundled Unicode full case mapping and is stable within the required major
  version, so an operating-system, provider, extension, or dictionary update
  cannot silently change query-time normalization while stored columns and
  indexes retain older values.
  Messages, summaries, and promoted memories store generated
  `simple`-configuration `tsvector` documents and have both full-text and
  normalized trigram GIN indexes. The function uses a fixed search path and is
  not executable by `PUBLIC`. The migration creates this exact signature
  without replacement: a pre-existing function at that signature is treated as
  an operator collision, not overwritten.
- Primary keys and unique constraints supply their own B-tree indexes. Named
  secondary indexes cover stable ordering, reverse foreign-key traversal,
  JSONB containment, search, active rows, and queue or lease readiness. The
  repository issues must preserve the documented tie-breakers in their SQL.

## Searchable-content boundary

Issue #83 stores the complete content supplied for indexed messages, summaries,
and promoted memories. It does not silently truncate content before generating
the normalized `tsvector` or trigram index entries. PostgreSQL full-text search
does not index a lexeme that reaches its per-lexeme size limit. The
[PostgreSQL 18 full-text limitations](https://www.postgresql.org/docs/18/textsearch-limitations.html)
describe this as shorter than 2 KiB. In the pinned PostgreSQL 18 source,
`MAXSTRLEN` is 2,047 and the parser omits a token whose byte length is greater
than or equal to that value. The largest safe parsed lexeme is therefore 2,046
UTF-8 bytes. That boundary applies after `lcm.normalize_search_text(text)` and
PostgreSQL text parsing; a raw-content character or whitespace limit is not an
equivalent test.

Issue #85 preserves canonical message content and provides write conformance,
but lexical indexing is explicitly outside its scope. Its writes do not promise
that every oversized normalized parser token is retrievable through full-text
search, and they do not truncate canonical content to create that impression.
Issue #89 must pin the 2,046-byte post-normalization/parser boundary with the
PostgreSQL 18 UTF-8 harness, then define rejection or lossless routing through
`message_parts` or `large_files` before #224 activates PostgreSQL application
writes. Future searchable write adapters in #86–#91 must make the same decision
for their own fields rather than applying a database-independent raw-token
approximation.

Those adapters must also benchmark the write cost of pinned normalization plus
generated full-text and trigram index maintenance before enabling high-volume
ingest. The measured workload should include representative content sizes,
languages, concurrency, and the oversized-payload routing path; issue #83 does
not claim a throughput budget for future repository implementations.

## Conversation repository contract

A session can contain more than one conversation segment. Creating a
conversation explicitly always creates a new segment. Session lookup returns
the newest exact-text match ordered by `created_at DESC, conversation_id DESC`;
the SHA-256 value is only a bounded lookup candidate and never replaces the
exact `session_id` residual. Concurrent get-or-create calls for the same
project and exact session are serialized by a transaction-scoped advisory lock
and converge on that newest segment. The lock key casts the project ID through
PostgreSQL's UUID type first, so equivalent uppercase and lowercase UUID text
cannot select different locks.

Conversation lists use `created_at, conversation_id` ascending. Messages use
their conversation-scoped `seq` ascending, and message parts use `ordinal`
ascending. PostgreSQL stores part ordinals as `bigint`; the adapter accepts
nonnegative JavaScript safe integers and applies the same checked conversion
when reading them. These final identity tie-breakers are part of the repository
contract, so equal timestamps do not make pagination or selection
nondeterministic.

`appendMessages` allocates a whole batch while holding a row lock on the owning
conversation. The first appended message uses sequence `0`; later batches use
`MAX(seq) + 1` and receive a contiguous range. Append token counts must be
nonnegative safe integers and are rejected before a transaction starts when
invalid. Conversation session/title text, message content, and every
message-part text field are rejected before transaction or query entry when
they contain U+0000 (NUL); metadata receives only this check and otherwise
remains opaque. Explicit-sequence single and bulk creation remain available for
replay and import. These two write modes may
be used sequentially, but callers must
not run append allocation and explicit-sequence creation concurrently for the
same conversation: the row lock coordinates append allocators, while
replay/import deliberately supplies its own sequence values. Concurrent
append-only calls remain safe. Bulk message creation, part insertion, and
multi-message deletion are atomic
operations: they either commit completely or leave no partial rows. When
called inside a repository transaction they join that transaction instead of
opening a nested one. Every scoped operation uses the same executor-level FIFO;
mapped writes, bootstrap marking, and part insertion use runtime-owned
savepoint callbacks with generated identifiers, private control SQL, a drained
temporary inner executor, and async-context fencing of outer or nested scope
use from inside the callback. Independent sibling operations queue behind the
complete savepoint lifecycle, while captured inner executors reject after the
callback settles. Ordinary statement and mapping failures recover only when
both `ROLLBACK TO` and `RELEASE` succeed; open, control, connection, and abort
failures poison the outer transaction. Reads therefore cannot observe
transient rows and savepoints cannot overlap. Scoped get-or-create and append
first verify the effective transaction isolation is
exactly `READ COMMITTED`; missing, malformed, or stronger isolation fails with
a sanitized storage error before any advisory lock, row lock, or write. Begin
the outer transaction at `READ COMMITTED`, or call these methods through a root
repository that creates its own short transaction; a scoped repository cannot
change isolation after the outer transaction has executed a statement.
Only serialization failures (`40001`) and deadlocks (`40P01`) are retried, with
at most three attempts; a commit whose outcome is uncertain is never replayed
automatically.

`getMaxSeq` preserves SQLite's legacy return value of `0` for an empty
conversation. A conversation containing only sequence `0` has the same
maximum, so `0` is not an emptiness signal; callers must use `getMessageCount`
when they need to distinguish those states.

Message deletion retains the SQLite summary-protection rule. A message
referenced by `summary_messages` is skipped, while an eligible message is
removed from active `context_items` before the message is deleted. Owned
`message_parts` then disappear through the existing cascade. The complete
multi-ID operation is atomic, including the skipped-message decisions.

PostgreSQL exposes generated `bigint` identities, sequence values, and counts
as text through the driver. The adapter parses decimal strings and native
bigints exactly, checks them against bigint forms of
`Number.MIN_SAFE_INTEGER` and `Number.MAX_SAFE_INTEGER`, and only then converts
them to JavaScript numbers. Malformed, fractional, exponent-form, or
out-of-range values fail with a sanitized storage error instead of being
rounded. Nonnegative domain checks remain independently enforced by the
schema.

## Ownership, deletion, and retention

"Owned" below means a row has no independent lifecycle outside its parent and
therefore uses `ON DELETE CASCADE`. Shared identity roots and independent source
references use `RESTRICT`, so deletion requires an explicit, ordered
administrative operation. Source references inside the same conversation-owned
graph use `NO ACTION DEFERRABLE INITIALLY DEFERRED`: deleting a referenced row
directly still fails when the transaction commits, while deleting the
conversation root can first cascade every owned row without a statement-order
cycle. Join rows cascade only from the record that owns the relationship.
Promoted-memory provenance identifiers are external nullable text, are not
owner-scoped foreign keys, and remain unchanged when a same-named local summary
is deleted.

The baseline does not run retention jobs or silently delete records. Identity,
source, derived, and administrative records are retained until an explicit
future repository operation removes them. Archived promoted memories remain
stored. Applied inbox events may be pruned only after the acknowledgement rules
in #91 are implemented. Released or expired lease rows are short-lived
coordination state, but cleanup must use row deletion without truncating or
restarting `fenced_leases_fencing_token_seq`. The sequence is durable schema
state, owned by `fenced_leases.fencing_token`, and is retained for the table's
lifetime. Cleanup, allocation transactions, takeover, and final-write fence
checks belong to #90. Provider backup retention is independent of live-table
deletion.

## Table catalog

### Migration control

| Table | Ownership and retention | Enforced invariants and indexes |
| --- | --- | --- |
| `schema_migrations` | Migrator-owned ordinary table retained for the database lifetime. Application code must never edit it. A catalog-only preflight rejects a view, materialized view, foreign table, other relation kind, or ownership drift before reading ledger rows; absence remains valid only for first installation. | Migration ID primary key; checksum is exactly 64 lowercase hexadecimal characters; `applied_at` is timezone-aware. The runner also enforces manifest order and checksum equality. |

### Identity

| Table | Ownership and retention | Enforced invariants and indexes |
| --- | --- | --- |
| `machines` | Independent identity root. Retain through reimages and require aliases, transcripts, checkpoints, instructions, inbox events, and leases to be handled before deletion. All incoming references restrict deletion. | UUIDv7-enforced primary key; globally unique `identity_key` in the exact `machine:<64 lowercase hex>` format used by the private local identity file; optional nonblank display name; `last_seen_at >= registered_at`. |
| `projects` | Independent identity root and project-scope anchor. No dependent table silently cascades from project deletion. | UUIDv7-enforced internal primary key; required unique `identity_key` is an opaque random 32-byte value generated for each PostgreSQL project creation and is never derived from a local path/hash; `updated_at >= created_at`. |
| `project_aliases` | Explicit machine-to-project link retained until unlink. Both project and machine references restrict deletion. | `(machine_id, normalized_path)` primary key makes one normalized path on a machine resolve to one project; `UNIQUE (machine_id, path)` prevents the same stored lexical spelling from being redirected after a symlink is retargeted. Both paths are nonempty and normalized path is trimmed and nonempty. `project_aliases_project_idx` supports project-to-machine/path listing. |

### Source records

| Table | Ownership and retention | Enforced invariants and indexes |
| --- | --- | --- |
| `conversations` | Project-scoped source root. Project deletion is restricted; an explicit conversation deletion owns messages, summaries, context, and large-file metadata. Multiple rows may represent segments of one session. | Generated `bigint` primary key and scoped identity; exact nonnull session text, including whitespace-only and arbitrary-length caller values accepted by the shared contract; ordered timestamps and optional bootstrap time. `conversations_project_order_idx` supplies deterministic newest-first project ordering, while `conversations_session_lookup_idx` uses the fixed-width session SHA-256 candidate. Every lookup retains exact `session_id` equality as a collision residual. |
| `messages` | Owned by a conversation and cascades with it. Coverage, context, and transcript provenance references restrict direct deletion until those relationships are handled. | Generated `bigint` primary key; scoped unique sequence and identity; nonnegative sequence and token count; four-role enum. The scoped sequence unique index provides conversation order and `messages_project_created_idx` provides stable project order; `messages_search_document_idx` and `messages_content_trgm_idx` provide FTS and substring/fuzzy access. |
| `message_parts` | Owned by a message and cascades with it. | UUID primary key with a UUIDv7 default; unique scoped nonnegative `bigint` ordinal, checked by the adapter before JavaScript conversion; exact nonnull session text; closed part-type enum; nonnegative token fields; finite nonnegative cost. Nullable metadata is opaque text and round-trips unchanged. `message_parts_type_idx` supports scoped type/order access. |
| `native_transcripts` | Project- and machine-scoped scrubbed source. Both roots restrict deletion. The #86 repository is append-only and exposes no pre-redaction or implicit deletion path. | UUIDv7-enforced primary key; nonblank client/format/version/session/scrubber/source fields; nonnegative source ordinal; 64-character lowercase SHA-256 content digest and ingest key; object-or-array JSON payload; idempotent `(project_id, machine_id, ingest_key)`; `ingested_at >= observed_at`. Source-order and fixed-width native-session digest indexes give deterministic provenance scans with exact-text residuals; `native_transcripts_payload_idx` supplies JSONB path containment. |
| `transcript_messages` | Transcript-owned provenance join: deleting a transcript cascades its links, while the derived message side restricts deletion. | Scoped transcript and message foreign keys; unique message and source ordinal within a transcript; nonnegative source ordinal. `transcript_messages_message_idx` supports reverse provenance lookup. |

### Derived memory

| Table | Ownership and retention | Enforced invariants and indexes |
| --- | --- | --- |
| `summaries` | Owned by a conversation and cascades with it. Coverage, parent, context, and file links govern direct deletion. Promoted-memory provenance is an unbound external identifier. | Exact, unbounded caller `summary_id` text is unique within a project and defaults to UUIDv7 text when omitted. A generated SHA-256 candidate plus exact residual comparison enforces and looks up that identity; a UUIDv7 `summary_key` is the bounded primary/relationship key. Leaf/condensed kind, nonnegative counts, and ordered optional timestamps are enforced. Conversation/project B-tree order uses the stable internal key; FTS and normalized trigram GIN indexes cover content. |
| `summary_messages` | Summary-owned coverage join: deleting the summary cascades coverage, while direct source-message deletion fails at commit. | Bounded `summary_key` relationships carry explicit project/conversation scope. The source side is deferred `NO ACTION` so a populated conversation-root cascade can delete both sides; source message and ordinal are unique per summary and ordinal is nonnegative. `summary_messages_message_idx` supports reverse message coverage. |
| `summary_parents` | Child-summary-owned DAG edge: deleting the child cascades its outgoing edges, while direct parent deletion fails at commit. | Bounded child and parent summary keys carry explicit project/conversation scope. The parent side is deferred `NO ACTION` so a populated conversation-root cascade can delete the entire graph; parent and ordinal are unique per child, ordinal is nonnegative, and self-edges are rejected. `summary_parents_parent_idx` supports deterministic reverse traversal. General cycle rejection is a transactional repository invariant owned by #87 with #90 fencing; adapters remain disabled until it is implemented. |
| `context_items` | Ordered projection owned by a conversation and cascades with it. Direct deletion of a referenced message or summary fails at commit. | `(project_id, conversation_id, ordinal)` primary key; message IDs and bounded summary keys are deferred `NO ACTION` references so populated conversation-root cascades remain valid; nonnegative ordinal; exactly one source reference consistent with `item_type`. Partial message and summary indexes support reverse membership checks. Atomic range replacement and stale-fence rejection belong to #87/#90. |
| `large_files` | Metadata owned by a conversation and cascades with it; external bytes at `storage_uri` have their own lifecycle. | Exact, unbounded caller `file_id` text is unique within a project and defaults to UUIDv7 text when omitted. A generated SHA-256 candidate plus exact residual comparison enforces and looks up that identity; UUIDv7 `file_key` is the bounded primary, scoped, and ordering key. Optional byte size is nonnegative and storage URI is nonblank. |
| `summary_large_files` | Ordered file-reference array owned by a summary and deleted with it. The file ID is opaque provenance: it can remain unresolved or name a file owned by another conversation without blocking summary creation. Direct deletion of a matching `large_files` row preserves the historical summary reference. | The owner project, conversation, and bounded summary key remain protected by a scoped summary foreign key. Ordinal identity preserves caller order and repeated IDs; exact unbounded file text plus its generated SHA-256 candidate supports bounded lookup. File IDs deliberately have no existence foreign key, and an exact residual predicate is required. |

### Recall and administration

| Table | Ownership and retention | Enforced invariants and indexes |
| --- | --- | --- |
| `promoted_memories` | Durable memory owned by the UUID `project_id` scope. The independent nullable text `source_project_id` and `source_summary_id` preserve backend-neutral provenance without asserting that either identifies a local row. Project deletion is restricted; summary deletion cannot erase provenance. Archive is a retained lifecycle state. | UUID primary key with a UUIDv7 default; nonempty content; nonnegative depth; confidence in `[0,1]`; object JSON metadata; archive time not before creation. The unbounded source-summary text uses a generated SHA-256 candidate index with an exact residual predicate. Active, source, metadata JSONB, FTS, and trigram indexes support lifecycle, provenance, filtering, and search. |
| `promoted_memory_tags` | Ordered exact tag array owned by a promoted memory; cascades when its promoted memory is deleted. | Ordinal identity preserves order, duplicates, case distinctions, empty tags, surrounding whitespace, and unbounded tag length exactly. `tag` remains the case-sensitive filtering value. The generated lowercase `normalized_tag` uses the same builtin `pg_unicode_fast` mapping as search but is neither identity nor a uniqueness boundary. Fixed-width generated SHA-256 keys keep raw and normalized B-tree lookups within PostgreSQL index-tuple limits; lookup predicates use the corresponding hash and retain exact `tag` or `normalized_tag` comparison as collision verification. Generated FTS and normalized trigram GIN indexes let promoted-memory search include tag-only matches. |
| `recall_surfacing` | Project-owned historical usage evidence retained independently when a promoted-memory row is missing or deleted. Project deletion remains restricted. | Generated `bigint` primary key and opaque text `memory_id`; there is deliberately no promoted-memory foreign key, so arbitrary caller IDs, orphan observations, and historical feedback round-trip. Memory-order and partial fixed-width session-digest indexes provide deterministic recall and feedback aggregation with exact-text residuals. |
| `redaction_counters` | Project-scoped aggregate retained as administrative state; project deletion is restricted. It contains counts, not redacted content. | One row per project and `built_in`, `global`, `project`, or `gitleaks` category; nonnegative count; timezone-aware update time. |
| `ingest_checkpoints` | Project/machine/client/source coordination retained for resumable native ingestion; both identity roots restrict deletion. | Composite primary key; nonnegative source ordinal and imported/skipped/quarantined counts; object JSON checkpoint. `ingest_checkpoints_payload_idx` supports JSONB path inspection. |
| `session_ingest_log` | Project-scoped completion marker retained to make whole-session ingestion idempotent; project deletion is restricted. Remove it only through an explicit replay or administrative workflow. | UUIDv7 `ingest_key` primary key; exact nonnull arbitrary-length session ID, including whitespace-only values; generated SHA-256 lookup candidate; nonnegative message count; timezone-aware completion time. Under required `READ COMMITTED` isolation, the identity trigger uses a project/digest advisory lock plus exact residual to enforce one matching session per project without placing raw text in a B-tree; on updates it excludes the row identified by `OLD.ingest_key`, so rotating the primary key does not mistake that row for a duplicate while collisions with other rows still fail. Higher isolation fails closed with SQLSTATE `0A000`. `session_ingest_log_completed_idx` supplies deterministic newest-first project scans. |
| `session_instructions` | Project-scoped cached instruction content, optionally machine-specific. Project and machine references restrict deletion. | Generated `bigint` primary key; nonnegative slot; caller-defined text content hash preserved unchanged; `UNIQUE NULLS NOT DISTINCT (project_id, machine_id, slot)` permits one project-global value per slot. |

### Distributed coordination

| Table | Ownership and retention | Enforced invariants and indexes |
| --- | --- | --- |
| `passive_event_inbox` | Durable remote copy of a machine's local hook-outbox event. Project and machine deletion are restricted. Retain pending, claimed, retry, and quarantined rows; prune applied rows only after #91's acknowledgement policy. | Generated `bigint` primary key; unique event ID and sequence per machine; positive version, nonnegative sequence/attempt count; closed status enum; claim, applied, and quarantine columns must agree with status; nonnull claim owners and quarantine reasons must be nonblank after trimming. Claim, next-attempt, applied, and quarantine timestamps cannot precede receipt. Equality is permitted for immediate first attempts and claims. Partial ready, retry-time, and claimed-age B-tree indexes support `SKIP LOCKED` claims and recovery; payload uses a JSONB path-ops GIN index. |
| `fenced_leases` | Project resource lease owned operationally by a machine/process. The project and owner-machine foreign keys both use `ON DELETE RESTRICT`. Released or expired rows may be deleted under #90, but the column-owned token sequence is retained until an explicit schema migration drops the table and must never be restarted by cleanup. | `(project_id, resource_type, resource_key)` primary key permits one current row per scoped resource; resource and owner/process/operation fields are nonblank. `fencing_token` is a generated-always `bigint` identity with a positive check, backed by `fenced_leases_fencing_token_seq`, so delete-and-reacquire cannot reuse a generated token. `renewed_at >= acquired_at`, `expires_at > renewed_at`, and `released_at >= renewed_at` when released. Partial active-owner and active-expiry indexes support diagnostics and takeover; `fenced_leases_owner_machine_idx` covers the complete machine foreign key. Allocation transactions, takeover updates, and final-write fence checks remain behavioral requirements in #90. |

## Named index catalog

Primary keys and unique constraints create additional B-tree indexes. The 52
explicit indexes below cover ordering, reverse foreign-key checks, search,
JSONB inspection, and active-state selection.

| Area | Indexes and purpose |
| --- | --- |
| Project identity | `project_aliases_project_idx` reverses aliases by project; `conversations_project_order_idx` gives deterministic newest-first project order; `conversations_session_lookup_idx` uses the session digest candidate for bounded session-wide aggregation and newest-segment selection with an exact residual. |
| Messages and parts | `messages_project_created_idx` orders project messages; `messages_search_document_idx` and `messages_content_trgm_idx` provide FTS and normalized trigram access; `message_parts_type_idx` supports scoped type scans. Opaque part metadata has no semantic index. |
| Native transcripts | `native_transcripts_source_order_idx` and `native_transcripts_session_idx` provide deterministic provenance/session scans; `native_transcripts_machine_idx` covers the machine FK; `native_transcripts_payload_idx` provides JSONB path lookup; `transcript_messages_message_idx` reverses provenance by message. |
| Summaries | `summaries_identity_lookup_idx` bounds project-scoped external-ID candidates by SHA-256 and requires the exact `summary_id` residual; `summaries_conversation_order_idx` and `summaries_project_recent_idx` provide deterministic conversation/project order by the UUIDv7 relationship key; `summaries_search_document_idx` and `summaries_content_trgm_idx` provide FTS and trigram access. |
| Summary joins | `summary_messages_message_idx` and `summary_messages_summary_idx` cover both scoped coverage FKs; `summary_parents_parent_idx` and `summary_parents_summary_idx` cover both DAG directions; `summary_large_files_summary_idx` covers the owner FK and `summary_large_files_file_idx` uses the opaque file digest candidate for bounded owner-project lookup with an exact text residual. |
| Context and large files | Partial `context_items_message_idx` and `context_items_summary_idx` reverse active context membership; `large_files_identity_lookup_idx` bounds project-scoped caller-ID candidates by SHA-256 and requires exact `file_id` comparison; `large_files_conversation_order_idx` orders by the bounded UUIDv7 file key. |
| Promoted memory and recall | `promoted_memories_active_order_idx` supports active/stale scans; partial `promoted_memories_source_summary_idx` uses a bounded source-summary SHA-256 candidate and requires the exact source text residual without imposing a foreign key; partial `promoted_memories_source_project_idx` supports active owner-scoped source filtering; `promoted_memories_metadata_idx`, `promoted_memories_search_document_idx`, and `promoted_memories_content_trgm_idx` cover metadata and content search; `promoted_memory_tags_lookup_idx` uses `(project_id, tag_sha256, memory_id)` for bounded exact case-sensitive candidate lookup while `promoted_memory_tags_normalized_lookup_idx` uses `(project_id, normalized_tag_sha256, memory_id)` for bounded normalized candidates. Both require a residual exact text comparison to reject theoretical hash collisions. `promoted_memory_tags_search_document_idx` and `promoted_memory_tags_tag_trgm_idx` support tag-only lexical search; `recall_surfacing_memory_order_idx` and partial `recall_surfacing_session_order_idx` support recall aggregation. |
| Ingest and instructions | `ingest_checkpoints_payload_idx` provides JSONB path lookup; `ingest_checkpoints_machine_idx` covers machine deletion; `session_ingest_log_identity_lookup_idx` bounds exact session candidates by digest and UUIDv7 key; `session_ingest_log_completed_idx` orders completed sessions; partial `session_instructions_machine_idx` covers machine-specific instruction deletion. |
| Passive inbox | Partial `passive_event_inbox_ready_idx`, `passive_event_inbox_retry_idx`, and `passive_event_inbox_claimed_idx` cover claim/retry recovery; `passive_event_inbox_payload_idx` provides JSONB path lookup; `passive_event_inbox_project_idx` covers project deletion for every status. |
| Fenced leases | Partial `fenced_leases_owner_idx` and `fenced_leases_expiry_idx` cover active-owner and expiry scans; `fenced_leases_owner_machine_idx` covers the complete machine FK independently of release state. |

## Required extensions and PostgreSQL version

Readiness requires PostgreSQL major version 18 and all four extensions installed
in the `public` schema at the server's current `default_version`:

| Extension | Baseline purpose |
| --- | --- |
| `unaccent` | Operational prerequisite and provenance for the pinned accent-insensitive rule set. Migration tests compare every embedded source mapping with PostgreSQL 18.4's dictionary, but indexed normalization does not call the mutable dictionary at runtime. |
| `pg_trgm` | GIN operator support for bounded substring and fuzzy lexical fallback. |
| `pgcrypto` | Supplies fixed-width SHA-256 candidate keys for unbounded summary IDs, large-file IDs, session IDs, opaque file and summary provenance, and promoted-memory tags. Exact residual text comparison remains mandatory. IDs still use PostgreSQL 18's native `uuidv7()`, and content hashes arrive as validated lowercase SHA-256 values. |
| `pg_stat_statements` | Operator-visible query statistics for diagnosing repository and query-plan behavior; the server must preload it when required by the installation. |

Preflight reports each extension as `current`, `installed-unavailable`,
`not-preloaded`, `uninstalled`, `unavailable`, `version-mismatch`, or
`wrong-namespace`. Structured status includes the installed and default
versions, `requiredSchema`, `installedSchema`, `relocatable`,
`preloadRequired`, `preloaded`, and sanitized remediation. New-install guidance
uses `CREATE EXTENSION ... WITH SCHEMA "public"`. A version mismatch remains
unready because the installed version must exactly equal the server default,
but the diagnostic does not infer upgrade direction or emit `ALTER EXTENSION
... UPDATE TO`: an installed version may be newer than the default and a
downgrade path may not exist. Guidance instead tells the administrator to use a
provider-supported version-management path to align the versions and rerun
readiness. Catalog-controlled version strings are retained in the structured
`installedVersion` and `defaultVersion` fields but are never interpolated into
remediation SQL or prose, so backslashes and quotes cannot change a copied
command. Catalog relations, functions, and the equality and regular-expression
operators used by inspection are all explicitly bound to `pg_catalog`, so an
ambient schema cannot shadow readiness behavior.

`installed-unavailable` means PostgreSQL still records the extension but its
matching control files are unavailable. Guidance restores those files for the
installed version and reruns readiness; it does not incorrectly suggest
`CREATE EXTENSION`. `not-preloaded` applies to an otherwise-current
`pg_stat_statements`: readiness performs the non-mutating functional query
`SELECT stats_reset FROM public.pg_stat_statements_info`. PostgreSQL SQLSTATE
`55000` is classified as `not-preloaded`; permission, cancellation, transport,
and other database failures remain failures rather than being mislabeled.
Migration captures the postmaster start time before this pre-transaction probe
and, under the advisory lock, verifies that the postmaster did not restart,
that the module remains loaded, and that every extension still has the exact
installed/default version and schema observed by policy. This locked catalog
revalidation does not repeat the functional probe and remains protected through
commit. Guidance tells the administrator to add the
module to `shared_preload_libraries`, restart PostgreSQL, and rerun readiness.
Runtime health does not evaluate the search fingerprint, which depends on
`public.digest`, until every required extension is current in `public`; missing
or misplaced `pgcrypto` therefore returns the structured extension diagnostic
instead of a secondary fingerprint-query failure.

For a relocatable extension in the wrong namespace, guidance uses `ALTER
EXTENSION ... SET SCHEMA "public"`. For a non-relocatable installation, it
instead says that an administrator must plan a reinstall in `public`; LCM does
not suggest an unsafe automatic drop. LCM never installs, upgrades, relocates,
reinstalls, or drops an extension. A cluster administrator must complete and
verify that work before the migrator runs. Runtime health remains unavailable
unless all four statuses are `current`.

DigitalOcean Managed PostgreSQL supports PostgreSQL 18 on Standard Edition and
documents these extensions in its current
[supported-extension matrix](https://docs.digitalocean.com/products/databases/postgresql/details/supported-extensions/).
Standard Edition restricts installable extensions to its managed allowlist, so
operators should also verify the target cluster's `extwlist.extensions` and
install or upgrade extensions with an administrative account before migration.
The migrator is intentionally not a superuser.

The following extensions are not prerequisites:

- Deferred to an owning post-parity issue: `vector`, `vectorscale`, `anon`,
  `pg_cron`, `pg_partman`, `pg_stat_monitor`, and `pgaudit`.
- Rejected absent a measured use case: `hstore`, `lo`, `ltree`, and TimescaleDB.

Adding one requires an explicit migration and operational review; availability
on a provider does not justify silently expanding the baseline.

## Migration lifecycle

1. The cluster administrator provisions PostgreSQL 18, preloads services such
   as `pg_stat_statements` when necessary, and installs the exact required
   extensions in `public`. The migrator and runtime use separate login roles.
   With `storage.backend` configured, the supported packaged entry point is
   `LCM_POSTGRES_URL="$LCM_POSTGRES_MIGRATION_URL" lcm postgres migrate`; it
   accepts `--json` for automation and closes the migration pool before exit.
2. Runtime health verifies server version, UTF-8 database encoding, extension
   readiness, and the fingerprinted `lcm.search_v1` text-search contract.
   Failed readiness produces corrective guidance without changing database or
   cluster state.
3. The migration runner validates packaged SHA-256 artifacts, captures the
   postmaster epoch, requires UTF-8, and performs the functional extension probe
   before opening the DDL transaction. It then opens one transaction, takes a database-scoped
   transaction advisory lock, verifies PostgreSQL 18 before invoking the
   version-specific loaded-module catalog, verifies postmaster continuity,
   revalidates the non-probe extension catalog contract, verifies that any
   existing `lcm` schema is owned by the current migration role, rejects
   schema-level `PUBLIC CREATE`, and verifies ownership of every existing
   allowlisted object before reading the complete ordered ledger. After the
   ledger establishes the current snapshot, it verifies that snapshot's exact
   managed inventory and definitions before pending SQL. After applying the
   pending set, it verifies the newest snapshot registered for the target
   history, including its managed inventory, before commit. `0001` creates the
   `lcm` schema and immutable ledger; `0002`
   first rejects a pre-existing `lcm` schema that grants `PUBLIC CREATE`, then
   creates the 23-table baseline data model and indexes, the backend-neutral
   project identity key, and bounded session-identity lookup keys. The guard does not
   revoke or otherwise rewrite the pre-existing schema ACL. Its normalization
   helper uses non-replacing `CREATE FUNCTION`, so an existing same-signature
   function fails closed. Before commit, the runner verifies the LCM-owned
   `simple_v1` dictionary and `search_v1` configuration fingerprint. `0003`
   replaces the original nonblank-only machine identity-key check with the exact
   `machine:<64 lowercase hex>` contract and registers the corresponding schema
   fingerprint. Existing nonconforming rows stop the migration and are never
   rewritten; an operator must reconcile those rows from verified machine
   identity records before retrying. `0004` replaces the permissive machine
   display-name check with the CLI's recovery-safe contract: after local-style
   whitespace trimming the name must occupy 1–256 UTF-16 code units and must
   contain no control, bidirectional-formatting, line-separator, or
   paragraph-separator characters. `NULL` remains valid for legacy machines and
   is rendered through the deterministic `Machine <uuid>` fallback. Existing
   invalid non-null names stop the migration without being rewritten; correct
   them from verified machine records before retrying.
4. Each pending migration and its ledger row execute in that same transaction.
   Any DDL, constraint, index, privilege, or ledger failure rolls back the whole
   pending set. Repeated and concurrent runs converge on the same ordered
   history. A helper-signature collision therefore preserves the existing
   function and rolls back every domain object from the failed pending set.
5. Unknown, missing, out-of-order, or checksum-drifted history is fatal. Never
   rewrite a released migration, edit the ledger, drop an unknown schema, or
   auto-repair data. Restore the expected artifact/database or add a new ordered
   migration.

`lcm.search_v1` uses PostgreSQL 18's `pg_catalog.default` parser and an
LCM-owned `lcm.simple_v1` dictionary with 19 explicit token mappings. Its
catalog fingerprint covers the parser OID, ordered token mappings, dictionary
template/options and ownership, plus the complete
`lcm.normalize_search_text(text)` definition, owner, security mode, and
per-function configuration. Its ACL accepts the owning role plus non-`PUBLIC`
runtime roles only when every entry is owner-granted, non-grantable `EXECUTE`;
`PUBLIC`, grant-option, foreign-grantor, and other privilege shapes fail closed.
No runtime role owns any of these objects. All stored vectors and query
constructors must name `lcm.search_v1`.

Changing the text-search configuration or normalization rules requires a new
immutable migration; updating `unaccent` alone does not adopt new mappings.
That migration must run
under the same advisory lock and transaction as the ledger update and perform
all of the following:

1. Replace the embedded mapping, both fingerprints, and the body of
   `lcm.normalize_search_text(text)` with the reviewed rule set.
2. Rewrite each stored generated column with PostgreSQL 18's `SET EXPRESSION`
   form, even though the SQL expression text remains the same. This
   deterministically recomputes every stored value with the new function:

   ```sql
   ALTER TABLE lcm.messages ALTER COLUMN search_document SET EXPRESSION AS
     (to_tsvector('lcm.search_v1'::regconfig, lcm.normalize_search_text(content)));
   ALTER TABLE lcm.summaries ALTER COLUMN search_document SET EXPRESSION AS
     (to_tsvector('lcm.search_v1'::regconfig, lcm.normalize_search_text(content)));
   ALTER TABLE lcm.promoted_memories ALTER COLUMN search_document SET EXPRESSION AS
     (to_tsvector('lcm.search_v1'::regconfig, lcm.normalize_search_text(content)));
   ALTER TABLE lcm.promoted_memory_tags ALTER COLUMN search_document SET EXPRESSION AS
     (to_tsvector('lcm.search_v1'::regconfig, lcm.normalize_search_text(tag)));
   ```

3. Rebuild the four `*_search_document_idx` GIN indexes with plain
   transactional `REINDEX INDEX`. Rebuild the four trigram indexes too only
   when `lcm.normalize_search_text` changes; a text-configuration-only change
   does not affect their expressions.
   Do not use `CONCURRENTLY` inside the migration transaction:

   ```sql
   REINDEX INDEX lcm.messages_search_document_idx;
   REINDEX INDEX lcm.messages_content_trgm_idx;
   REINDEX INDEX lcm.summaries_search_document_idx;
   REINDEX INDEX lcm.summaries_content_trgm_idx;
   REINDEX INDEX lcm.promoted_memories_search_document_idx;
   REINDEX INDEX lcm.promoted_memories_content_trgm_idx;
   REINDEX INDEX lcm.promoted_memory_tags_search_document_idx;
   REINDEX INDEX lcm.promoted_memory_tags_tag_trgm_idx;
   ```
4. Record the migration only after all four rewrites and all eight index rebuilds
   succeed. Any failure must roll back the function, generated values, indexes,
   and ledger together.

Writers must remain stopped until that migration commits. Never use `ALTER TEXT
SEARCH DICTIONARY`, an extension update, or an out-of-band function replacement
as a shortcut: those operations do not provide the atomic stored-column rewrite
and reindex contract.

If ownership preflight fails, an administrator must transfer the schema and all
LCM-owned objects to the configured migration role, or restore a correctly
owned database, before retrying. A `CREATE` grant alone is not a supported
substitute because later owner-only schema maintenance must remain available.
The recurring object check is limited to the exact baseline table, identity
sequence, function, dictionary, and configuration names and signatures;
operator-owned objects not on that allowlist may retain another owner.
Structured diagnostics report `requiredOwner` as the sanitized role name
resolved from PostgreSQL `CURRENT_USER`, not a generic label, and provide
identifier-quoted transfer guidance. Missing, malformed, or contradictory
ownership catalog values fail closed without exposing the existing owner,
connection details, or raw database errors.

After schema creation, an administrator grants each implemented repository
only its exact runtime privileges with the reviewed
[`postgresql-runtime-identity-grants.sql`](postgresql-runtime-identity-grants.sql)
and
[`postgresql-runtime-conversation-grants.sql`](postgresql-runtime-conversation-grants.sql),
and
[`postgresql-runtime-transcript-grants.sql`](postgresql-runtime-transcript-grants.sql)
scripts:

```bash
psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file docs/postgresql-runtime-identity-grants.sql

psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file docs/postgresql-runtime-conversation-grants.sql

psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file docs/postgresql-runtime-transcript-grants.sql
```

Replace `lcm_runtime` with the deployment's runtime role. The script grants
schema `USAGE` and table `SELECT` where identity readback requires it. Writes
are column-scoped: machines may insert only `identity_key` and `display_name`
and update only `display_name` and `last_seen_at`; projects may insert only
their per-creation opaque random `identity_key` and `display_name`, and may delete rows;
aliases may insert `project_id`, `machine_id`, `path`, and `normalized_path`,
update only `project_id`, `path`, and `linked_at`, and delete rows. Generated
IDs and timestamps remain unwritable, and immutable machine identity, project
identity, and normalized-path columns cannot be updated after insertion. The
script grants no table ownership, `TRUNCATE`, sequence access, function
execution, schema creation, or privileges on future tables.
Without these grants, machine registration and project pairing fail closed
with a sanitized PostgreSQL operation error. Migrations intentionally do not
apply runtime grants because the migration role cannot safely infer a
deployment's runtime role.

The conversation script grants reads on conversations, messages, parts, and the
two relationship tables needed for summary-protected deletion. Inserts are
limited to repository-writable columns; updates are limited to conversation
bootstrap timestamps; deletion is limited to messages and their active context
references. The only sequence privilege is `USAGE` on the generated
conversation and message identity sequences. Part deletion occurs through the
message cascade, so the runtime receives no direct `DELETE` on
`message_parts`. Message inserts evaluate the stored generated
`search_document`, so the script also grants exact `EXECUTE` on
`lcm.normalize_search_text(text)`; `PUBLIC` execution remains revoked.
Applying these grants permits direct repository use and conformance testing
only; daemon and CLI routing remain staged behind #224 and #92.

The transcript script grants `SELECT` plus column-limited `INSERT` on
`native_transcripts` and `transcript_messages`. It grants `SELECT`,
column-limited `INSERT`, and `UPDATE` only for checkpoint position, cumulative
accounting, checkpoint payload, and update time on `ingest_checkpoints`.
PostgreSQL-generated transcript IDs, ingested timestamps, and native-session
digest columns remain unwritable. The script grants no payload update,
`DELETE`, `TRUNCATE`, sequence privilege, or access to an unrelated domain
table. Matching ingest-key retries are therefore handled through readback,
while a conflicting immutable record fails closed. See
[PostgreSQL native transcripts](postgresql-native-transcripts.md) for the
sanitized-record and local-quarantine contract.

Migration privilege hardening is likewise confined to LCM-owned objects: it
does not change ACLs on unknown objects already present in `lcm`. If an
administrator has granted schema-level `PUBLIC CREATE`, they must remove that
privilege outside LCM and rerun migration; LCM fails closed rather than mutating it.
When #90 enables lease writes, its runtime grant must include only the sequence
privileges required to consume `fenced_leases_fencing_token_seq`; normal
maintenance must not receive sequence restart or table-truncate authority.

## Backup and point-in-time recovery

- Back up and restore the complete database, including the `lcm` schema,
  migration ledger, caller-owned IDs, bounded summary/file relationship keys,
  generated digest candidates, sequences, normalized relationships, and
  extension catalog expectations. Do not restore selected application tables
  without their scoped parents and restricted source relationships.
- After restore or point-in-time recovery, run readiness and migration-history
  checks before starting writers. Restore the required extensions at compatible
  current versions first; extension binaries and server preload configuration
  are cluster infrastructure, not rows in an application backup.
- The local `~/.lcm/machine.json`, project map, and SQLite hook outbox are not in
  a PostgreSQL backup. The metadata-only native-transcript quarantine under
  `~/.lcm/transcript-quarantine/` is local too. Preserve these separately.
  Recover a lost machine file
  with the explicit PostgreSQL machine UUID via `lcm machine recover`; restore
  project bindings explicitly via `lcm project link`. Once #91 exists, replay uses
  `(machine_id, event_id)` and machine sequence uniqueness to avoid duplicate
  remote inbox effects; do not acknowledge a local event solely because a
  restored checkpoint claims it was applied.
- A point-in-time restore can rewind inbox status, ingest checkpoints,
  instructions, recall history, counters, leases, and the fencing-token
  sequence. Stop application workers during recovery, verify the chosen
  recovery point, and ensure no worker from the abandoned timeline can write
  before resuming. Then let database-clock lease expiry govern takeover and
  resume only through the owning repository's reconciliation procedure. Do not
  manually lower or restart the restored fencing-token sequence.
- PostgreSQL stores only locally scrubbed native transcript payloads by design,
  but scrubbed content, messages, summaries, promoted memories, and metadata are
  still sensitive. Encrypt backups, restrict access, and align provider backup
  retention with policy. Deleting or redacting a live row does not retroactively
  remove it from already retained backups or PITR history.

For the isolated local/CI workflow and checksum recovery procedure, see
[PostgreSQL development](postgresql-development.md). For repository ownership
and the staged activation boundary, see [Architecture](architecture.md#storage-repository-architecture).
