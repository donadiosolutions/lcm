# PostgreSQL 18 schema reference

This reference describes the durable PostgreSQL baseline introduced by
`0001_migration_ledger.sql` and `0002_schema_baseline.sql`. The latter creates
23 domain tables. This is a schema and readiness contract, not an enabled
application backend. SQLite remains the authoritative production adapter.
PostgreSQL selection continues to fail before daemon startup until the
repositories in issues #84–#91 pass conformance and the cutover work in #92
explicitly enables the backend.

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
  ledger inspection, and the immutable baseline repeats the defense before its
  owned DDL. Either check aborts without changing the schema ACL. The baseline revokes
  privileges from `PUBLIC` on an explicit list of the 23 domain tables, the
  migration ledger, six generated identity sequences, and
  `lcm.normalize_search_text(text)` and the summary-identity trigger function.
  It deliberately grants no domain access to
  the runtime role while the adapters are disabled. Explicit object lists keep
  privileges on unknown pre-existing tables, sequences, and functions intact;
  issues #84–#91 must grant only the operations required by their repositories.
- The migration runner captures the postmaster epoch and completes required
  extension readiness, including the functional `pg_stat_statements` probe,
  before opening the DDL transaction. Inside that transaction it pins the local
  `search_path` to `pg_catalog, public` before taking the advisory lock, checking
  PostgreSQL 18 and postmaster/module continuity, revalidating the exact
  extension catalog snapshot without repeating the functional probe, checking
  schema ownership and `PUBLIC CREATE`, or executing pending SQL. This makes
  unqualified PostgreSQL built-ins in the immutable migrations resolve to native
  catalog objects while retaining intentional access to extension objects in
  `public`; the setting reverts on either commit or rollback. Extension
  inspection also schema-qualifies every catalog operator because it runs
  outside that migration transaction and runtime health uses the same
  inspection path.
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
  identity.
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
does not index a lexeme that reaches its implementation-specific per-lexeme
size limit, so adapters must not assume that every arbitrarily large token is
searchable. The exact byte boundary is a PostgreSQL implementation and encoding
detail, not a stable LCM schema constant.

Before enabling their write paths, issues #84–#91 must establish and test a
searchable-content bound against the pinned PostgreSQL 18 runtime. Input beyond
that bound must be rejected as searchable content or routed without data loss
to the appropriate `message_parts` or `large_files` representation, with a
bounded searchable summary or reference where the repository contract requires
one. Truncating the canonical message, summary, or promoted-memory content is
not an acceptable fallback.

Those adapters must also benchmark the write cost of pinned normalization plus
generated full-text and trigram index maintenance before enabling high-volume
ingest. The measured workload should include representative content sizes,
languages, concurrency, and the oversized-payload routing path; issue #83 does
not claim a throughput budget for future repository implementations.

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
| `schema_migrations` | Migrator-owned ledger retained for the database lifetime. Application code must never edit it. | Migration ID primary key; checksum is exactly 64 lowercase hexadecimal characters; `applied_at` is timezone-aware. The runner also enforces manifest order and checksum equality. |

### Identity

| Table | Ownership and retention | Enforced invariants and indexes |
| --- | --- | --- |
| `machines` | Independent identity root. Retain through reimages and require aliases, transcripts, checkpoints, instructions, inbox events, and leases to be handled before deletion. All incoming references restrict deletion. | UUIDv7-enforced primary key; nonblank globally unique `identity_key`; optional nonblank display name; `last_seen_at >= registered_at`. |
| `projects` | Independent identity root and project-scope anchor. No dependent table silently cascades from project deletion. | UUIDv7-enforced primary key; nonblank display name; `updated_at >= created_at`. |
| `project_aliases` | Explicit machine-to-project link retained until unlink. Both project and machine references restrict deletion. | `(machine_id, normalized_path)` primary key makes one normalized path on a machine resolve to one project; path is nonempty and normalized path is trimmed and nonempty. `project_aliases_project_idx` supports project-to-machine/path listing. |

### Source records

| Table | Ownership and retention | Enforced invariants and indexes |
| --- | --- | --- |
| `conversations` | Project-scoped source root. Project deletion is restricted; an explicit conversation deletion owns messages, summaries, context, and large-file metadata. Multiple rows may represent segments of one session. | Generated `bigint` primary key and scoped identity; exact nonnull session text, including whitespace-only caller values accepted by the shared contract; ordered timestamps and optional bootstrap time. `conversations_project_order_idx` supplies deterministic newest-first project ordering, while `conversations_session_lookup_idx` supports session-wide aggregation and deterministic newest-segment lookup. |
| `messages` | Owned by a conversation and cascades with it. Coverage, context, and transcript provenance references restrict direct deletion until those relationships are handled. | Generated `bigint` primary key; scoped unique sequence and identity; nonnegative sequence and token count; four-role enum. The scoped sequence unique index provides conversation order and `messages_project_created_idx` provides stable project order; `messages_search_document_idx` and `messages_content_trgm_idx` provide FTS and substring/fuzzy access. |
| `message_parts` | Owned by a message and cascades with it. | UUID primary key with a UUIDv7 default; unique scoped ordinal; exact nonnull session text; closed part-type enum; nonnegative ordinal and token fields; finite nonnegative cost. Nullable metadata is opaque text and round-trips unchanged. `message_parts_type_idx` supports scoped type/order access. |
| `native_transcripts` | Project- and machine-scoped scrubbed source. Both roots restrict deletion. The #86 repository is append-only and exposes no pre-redaction or implicit deletion path. | UUIDv7-enforced primary key; nonblank client/format/version/session/scrubber/source fields; nonnegative source ordinal; 64-character lowercase SHA-256 content digest and ingest key; object-or-array JSON payload; idempotent `(project_id, machine_id, ingest_key)`; `ingested_at >= observed_at`. Source-order and native-session B-tree indexes give deterministic provenance scans; `native_transcripts_payload_idx` supplies JSONB path containment. |
| `transcript_messages` | Transcript-owned provenance join: deleting a transcript cascades its links, while the derived message side restricts deletion. | Scoped transcript and message foreign keys; unique message and source ordinal within a transcript; nonnegative source ordinal. `transcript_messages_message_idx` supports reverse provenance lookup. |

### Derived memory

| Table | Ownership and retention | Enforced invariants and indexes |
| --- | --- | --- |
| `summaries` | Owned by a conversation and cascades with it. Coverage, parent, context, and file links govern direct deletion. Promoted-memory provenance is an unbound external identifier. | Exact, unbounded caller `summary_id` text is unique within a project and defaults to UUIDv7 text when omitted. A generated SHA-256 candidate plus exact residual comparison enforces and looks up that identity; a UUIDv7 `summary_key` is the bounded primary/relationship key. Leaf/condensed kind, nonnegative counts, and ordered optional timestamps are enforced. Conversation/project B-tree order uses the stable internal key; FTS and normalized trigram GIN indexes cover content. |
| `summary_messages` | Summary-owned coverage join: deleting the summary cascades coverage, while direct source-message deletion fails at commit. | Bounded `summary_key` relationships carry explicit project/conversation scope. The source side is deferred `NO ACTION` so a populated conversation-root cascade can delete both sides; source message and ordinal are unique per summary and ordinal is nonnegative. `summary_messages_message_idx` supports reverse message coverage. |
| `summary_parents` | Child-summary-owned DAG edge: deleting the child cascades its outgoing edges, while direct parent deletion fails at commit. | Bounded child and parent summary keys carry explicit project/conversation scope. The parent side is deferred `NO ACTION` so a populated conversation-root cascade can delete the entire graph; parent and ordinal are unique per child, ordinal is nonnegative, and self-edges are rejected. `summary_parents_parent_idx` supports deterministic reverse traversal. General cycle rejection is a transactional repository invariant owned by #87 with #90 fencing; adapters remain disabled until it is implemented. |
| `context_items` | Ordered projection owned by a conversation and cascades with it. Direct deletion of a referenced message or summary fails at commit. | `(project_id, conversation_id, ordinal)` primary key; message IDs and bounded summary keys are deferred `NO ACTION` references so populated conversation-root cascades remain valid; nonnegative ordinal; exactly one source reference consistent with `item_type`. Partial message and summary indexes support reverse membership checks. Atomic range replacement and stale-fence rejection belong to #87/#90. |
| `large_files` | Metadata owned by a conversation and cascades with it; external bytes at `storage_uri` have their own lifecycle. | Project-scoped `(project_id, file_id)` primary key preserves caller IDs independently in every project, with a UUIDv7-as-text default when omitted; nonnegative optional byte size; nonblank storage URI; conversation-scoped identity. `large_files_conversation_order_idx` orders by creation time and stable ID. |
| `summary_large_files` | Ordered file-reference array owned by a summary and deleted with it. The file ID is opaque provenance: it can remain unresolved or name a file owned by another conversation without blocking summary creation. Direct deletion of a matching `large_files` row preserves the historical summary reference. | The owner project, conversation, and bounded summary key remain protected by a scoped summary foreign key. Ordinal identity preserves caller order and repeated IDs; file IDs deliberately have no existence foreign key. `summary_large_files_file_idx` supports owner-project/exact-ID reverse lookup without asserting local file ownership. |

### Recall and administration

| Table | Ownership and retention | Enforced invariants and indexes |
| --- | --- | --- |
| `promoted_memories` | Durable memory owned by the UUID `project_id` scope. The independent nullable text `source_project_id` and `source_summary_id` preserve backend-neutral provenance without asserting that either identifies a local row. Project deletion is restricted; summary deletion cannot erase provenance. Archive is a retained lifecycle state. | UUID primary key with a UUIDv7 default; nonempty content; nonnegative depth; confidence in `[0,1]`; object JSON metadata; archive time not before creation. The unbounded source-summary text uses a generated SHA-256 candidate index with an exact residual predicate. Active, source, metadata JSONB, FTS, and trigram indexes support lifecycle, provenance, filtering, and search. |
| `promoted_memory_tags` | Ordered exact tag array owned by a promoted memory; cascades when its promoted memory is deleted. | Ordinal identity preserves order, duplicates, case distinctions, empty tags, surrounding whitespace, and unbounded tag length exactly. `tag` remains the case-sensitive filtering value. The generated lowercase `normalized_tag` uses the same builtin `pg_unicode_fast` mapping as search but is neither identity nor a uniqueness boundary. Fixed-width generated SHA-256 keys keep raw and normalized B-tree lookups within PostgreSQL index-tuple limits; lookup predicates use the corresponding hash and retain exact `tag` or `normalized_tag` comparison as collision verification. Generated FTS and normalized trigram GIN indexes let promoted-memory search include tag-only matches. |
| `recall_surfacing` | Project-owned historical usage evidence retained independently when a promoted-memory row is missing or deleted. Project deletion remains restricted. | Generated `bigint` primary key and opaque text `memory_id`; there is deliberately no promoted-memory foreign key, so arbitrary caller IDs, orphan observations, and historical feedback round-trip. Memory-order and partial nonnull-session indexes provide deterministic recall and feedback aggregation. |
| `redaction_counters` | Project-scoped aggregate retained as administrative state; project deletion is restricted. It contains counts, not redacted content. | One row per project and `built_in`, `global`, `project`, or `gitleaks` category; nonnegative count; timezone-aware update time. |
| `ingest_checkpoints` | Project/machine/client/source coordination retained for resumable native ingestion; both identity roots restrict deletion. | Composite primary key; nonnegative source ordinal and imported/skipped/quarantined counts; object JSON checkpoint. `ingest_checkpoints_payload_idx` supports JSONB path inspection. |
| `session_ingest_log` | Project-scoped completion marker retained to make whole-session ingestion idempotent; project deletion is restricted. Remove it only through an explicit replay or administrative workflow. | `(project_id, session_id)` primary key; exact nonnull session ID, including whitespace-only values; nonnegative message count; timezone-aware completion time. `session_ingest_log_completed_idx` supplies deterministic newest-first project scans. |
| `session_instructions` | Project-scoped cached instruction content, optionally machine-specific. Project and machine references restrict deletion. | Generated `bigint` primary key; nonnegative slot; caller-defined text content hash preserved unchanged; `UNIQUE NULLS NOT DISTINCT (project_id, machine_id, slot)` permits one project-global value per slot. |

### Distributed coordination

| Table | Ownership and retention | Enforced invariants and indexes |
| --- | --- | --- |
| `passive_event_inbox` | Durable remote copy of a machine's local hook-outbox event. Project and machine deletion are restricted. Retain pending, claimed, retry, and quarantined rows; prune applied rows only after #91's acknowledgement policy. | Generated `bigint` primary key; unique event ID and sequence per machine; positive version, nonnegative sequence/attempt count; closed status enum; claim, applied, and quarantine columns must agree with status; nonnull claim owners and quarantine reasons must be nonblank after trimming. Claim, next-attempt, applied, and quarantine timestamps cannot precede receipt. Equality is permitted for immediate first attempts and claims. Partial ready, retry-time, and claimed-age B-tree indexes support `SKIP LOCKED` claims and recovery; payload uses a JSONB path-ops GIN index. |
| `fenced_leases` | Project resource lease owned operationally by a machine/process. The project and owner-machine foreign keys both use `ON DELETE RESTRICT`. Released or expired rows may be deleted under #90, but the column-owned token sequence is retained until an explicit schema migration drops the table and must never be restarted by cleanup. | `(project_id, resource_type, resource_key)` primary key permits one current row per scoped resource; resource and owner/process/operation fields are nonblank. `fencing_token` is a generated-always `bigint` identity with a positive check, backed by `fenced_leases_fencing_token_seq`, so delete-and-reacquire cannot reuse a generated token. `renewed_at >= acquired_at`, `expires_at > renewed_at`, and `released_at >= renewed_at` when released. Partial active-owner and active-expiry indexes support diagnostics and takeover; `fenced_leases_owner_machine_idx` covers the complete machine foreign key. Allocation transactions, takeover updates, and final-write fence checks remain behavioral requirements in #90. |

## Named index catalog

Primary keys and unique constraints create additional B-tree indexes. The 50
explicit indexes below cover ordering, reverse foreign-key checks, search,
JSONB inspection, and active-state selection.

| Area | Indexes and purpose |
| --- | --- |
| Project identity | `project_aliases_project_idx` reverses aliases by project; `conversations_project_order_idx` gives deterministic newest-first project order; `conversations_session_lookup_idx` covers session-wide aggregation and newest-segment selection. |
| Messages and parts | `messages_project_created_idx` orders project messages; `messages_search_document_idx` and `messages_content_trgm_idx` provide FTS and normalized trigram access; `message_parts_type_idx` supports scoped type scans. Opaque part metadata has no semantic index. |
| Native transcripts | `native_transcripts_source_order_idx` and `native_transcripts_session_idx` provide deterministic provenance/session scans; `native_transcripts_machine_idx` covers the machine FK; `native_transcripts_payload_idx` provides JSONB path lookup; `transcript_messages_message_idx` reverses provenance by message. |
| Summaries | `summaries_identity_lookup_idx` bounds project-scoped external-ID candidates by SHA-256 and requires the exact `summary_id` residual; `summaries_conversation_order_idx` and `summaries_project_recent_idx` provide deterministic conversation/project order by the UUIDv7 relationship key; `summaries_search_document_idx` and `summaries_content_trgm_idx` provide FTS and trigram access. |
| Summary joins | `summary_messages_message_idx` and `summary_messages_summary_idx` cover both scoped coverage FKs; `summary_parents_parent_idx` and `summary_parents_summary_idx` cover both DAG directions; `summary_large_files_summary_idx` covers the owner FK and `summary_large_files_file_idx` supports exact opaque-reference lookup within the owner project. |
| Context and large files | Partial `context_items_message_idx` and `context_items_summary_idx` reverse active context membership; `large_files_conversation_order_idx` provides deterministic conversation order. |
| Promoted memory and recall | `promoted_memories_active_order_idx` supports active/stale scans; partial `promoted_memories_source_summary_idx` uses a bounded source-summary SHA-256 candidate and requires the exact source text residual without imposing a foreign key; partial `promoted_memories_source_project_idx` supports active owner-scoped source filtering; `promoted_memories_metadata_idx`, `promoted_memories_search_document_idx`, and `promoted_memories_content_trgm_idx` cover metadata and content search; `promoted_memory_tags_lookup_idx` uses `(project_id, tag_sha256, memory_id)` for bounded exact case-sensitive candidate lookup while `promoted_memory_tags_normalized_lookup_idx` uses `(project_id, normalized_tag_sha256, memory_id)` for bounded normalized candidates. Both require a residual exact text comparison to reject theoretical hash collisions. `promoted_memory_tags_search_document_idx` and `promoted_memory_tags_tag_trgm_idx` support tag-only lexical search; `recall_surfacing_memory_order_idx` and partial `recall_surfacing_session_order_idx` support recall aggregation. |
| Ingest and instructions | `ingest_checkpoints_payload_idx` provides JSONB path lookup; `ingest_checkpoints_machine_idx` covers machine deletion; `session_ingest_log_completed_idx` orders completed sessions; partial `session_instructions_machine_idx` covers machine-specific instruction deletion. |
| Passive inbox | Partial `passive_event_inbox_ready_idx`, `passive_event_inbox_retry_idx`, and `passive_event_inbox_claimed_idx` cover claim/retry recovery; `passive_event_inbox_payload_idx` provides JSONB path lookup; `passive_event_inbox_project_idx` covers project deletion for every status. |
| Fenced leases | Partial `fenced_leases_owner_idx` and `fenced_leases_expiry_idx` cover active-owner and expiry scans; `fenced_leases_owner_machine_idx` covers the complete machine FK independently of release state. |

## Required extensions and PostgreSQL version

Readiness requires PostgreSQL major version 18 and all four extensions installed
in the `public` schema at the server's current `default_version`:

| Extension | Baseline purpose |
| --- | --- |
| `unaccent` | Operational prerequisite and provenance for the pinned accent-insensitive rule set. Migration tests compare every embedded source mapping with PostgreSQL 18.4's dictionary, but indexed normalization does not call the mutable dictionary at runtime. |
| `pg_trgm` | GIN operator support for bounded substring and fuzzy lexical fallback. |
| `pgcrypto` | Supplies fixed-width SHA-256 candidate keys for unbounded summary IDs, external summary provenance, and promoted-memory tags. Exact residual text comparison remains mandatory. IDs still use PostgreSQL 18's native `uuidv7()`, and content hashes arrive as validated lowercase SHA-256 values. |
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
2. Runtime health verifies server version, extension readiness, and the
   fingerprinted `lcm.search_v1` text-search contract. Failed readiness produces
   corrective guidance without changing cluster state.
3. The migration runner validates packaged SHA-256 artifacts, captures the
   postmaster epoch, and performs the functional extension probe before opening
   the DDL transaction. It then opens one transaction, takes a database-scoped
   transaction advisory lock, verifies PostgreSQL 18 before invoking the
   version-specific loaded-module catalog, verifies postmaster continuity,
   revalidates the non-probe extension catalog contract, verifies that any
   existing `lcm` schema is owned by the current migration role, rejects
   schema-level `PUBLIC CREATE` on every run, and then verifies the
   complete ordered ledger. `0001` creates the `lcm` schema and immutable ledger; `0002`
   first rejects a pre-existing `lcm` schema that grants `PUBLIC CREATE`, then
   creates the 23-table baseline data model and indexes. The guard does not
   revoke or otherwise rewrite the pre-existing schema ACL. Its normalization
   helper uses non-replacing `CREATE FUNCTION`, so an existing same-signature
   function fails closed. Before commit, the runner verifies the LCM-owned
   `simple_v1` dictionary and `search_v1` configuration fingerprint.
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
per-function configuration; no runtime role owns any of these objects. All
stored vectors and query constructors must name `lcm.search_v1`.

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
Structured diagnostics report `requiredOwner` as the sanitized role name
resolved from PostgreSQL `CURRENT_USER`, not a generic label, and provide
identifier-quoted transfer guidance. Missing, malformed, or contradictory
ownership catalog values fail closed without exposing the existing owner,
connection details, or raw database errors.

After schema creation, an administrator may grant the runtime role only the
schema usage, table operations, sequence access, and function execution proven
necessary by implemented repositories. Issue #83 intentionally leaves those
domain grants absent because no PostgreSQL adapter is enabled yet. Migration
privilege hardening is likewise confined to LCM-owned objects: it does not
change ACLs on unknown objects already present in `lcm`. If an administrator
has granted schema-level `PUBLIC CREATE`, they must remove that privilege
outside LCM and rerun migration; LCM fails closed rather than mutating it.
When #90 enables lease writes, its runtime grant must include only the sequence
privileges required to consume `fenced_leases_fencing_token_seq`; normal
maintenance must not receive sequence restart or table-truncate authority.

## Backup and point-in-time recovery

- Back up and restore the complete database, including the `lcm` schema,
  migration ledger, identities, sequences, normalized relationships, and
  extension catalog expectations. Do not restore selected application tables
  without their scoped parents and restricted source relationships.
- After restore or point-in-time recovery, run readiness and migration-history
  checks before starting writers. Restore the required extensions at compatible
  current versions first; extension binaries and server preload configuration
  are cluster infrastructure, not rows in an application backup.
- The local `~/.lcm/machine.json`, project map, and SQLite hook outbox are not in
  a PostgreSQL backup. Preserve them separately. Once #91 exists, replay uses
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
