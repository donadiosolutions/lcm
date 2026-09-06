# Architecture

This document describes how Long Context Manager (LCM) works internally — the data model, compaction lifecycle, context assembly, and expansion system.

## Storage selection

The daemon resolves one storage backend during startup. SQLite is the default
and preserves the existing per-project database layout. PostgreSQL is an
explicit remote-primary selection whose production connection URL comes from
`LCM_POSTGRES_URL`; verified TLS uses the required `LCM_POSTGRES_CA_FILE`.
Trusted runtime overrides remain available to tests and embedded callers and
take precedence over the environment.
Configuration parsing, effective CLI output, doctor, daemon startup, and storage
construction share the same discriminated resolved configuration. This prevents
different entry points from applying different precedence or validation rules.

The internal PostgreSQL 18 runtime provides a bounded `pg` pool, verified CA
and hostname validation, sanitized SQLSTATE errors, abort cancellation,
transactional migrations, extension readiness, and the complete durable schema
baseline. The production PostgreSQL composition root eagerly verifies runtime
health, server and extension policy, the complete migration ledger, immutable
schema fingerprints, migration ownership, search configuration, and the exact
runtime ACL manifest. Only then can an explicit programmatic caller obtain a
backend factory. Project opening additionally validates terminal backend
publication evidence and the exact remote project UUID, machine ID/alias,
lexical selected path, and normalized path before composing all nine repository
contracts into one `ProjectStorage`. The project object owns its transaction
scope, health, cancellation, and close lifecycle; no SQL client escapes the
storage boundary.
Explicit embedded callers use the curated
`@donadiosolutions/lcm/storage/postgresql` package subpath. It exposes the
production factory and its minimum configuration/result contracts while
keeping runtime internals, migrators, and deterministic testing hooks private.

The native-transcript adapter is exposed as an explicit `ProjectStorage`
capability. Its backfill owns raw-record, message-link, and checkpoint batch
transactions after the parsed-message transaction commits. Native retries
therefore run even when all parsed messages already exist. Normal daemon
and MCP composition now select the verified PostgreSQL factory when the
published backend is explicitly `postgresql`. A valid terminal publication
witness, registered machine, and exact project binding are required before a
project opens. Unresolved or inconsistent publication, identity, or runtime
state fails closed with sanitized `409` identity or `503` storage responses;
the daemon never opens a project SQLite database as fallback. Request
cancellation closes the active project, and daemon shutdown aborts and drains
background consumers before closing the shared factory. The local SQLite hook
outbox and metadata-only transcript quarantine remain local and are not
general caches or activation paths. CLI/import-export remains #618-owned,
while stats, pool diagnostics, status, and doctor presentation remain
#619-owned. See the [PostgreSQL schema reference](../src/storage/postgresql/reference/postgresql-schema.md) for table ownership,
integrity, indexes, retention, extension policy, and recovery implications.

## Storage repository architecture

LCM's application code accesses project memory through asynchronous domain
repositories. A repository describes what LCM needs to do—for example, create a
message, traverse summary lineage, or record recall feedback—without exposing a
SQL connection, statement, transaction object, placeholder syntax, or other
backend-specific primitive.

SQLite remains the zero-configuration production default. The reusable
conformance suite is backend-neutral, and the PostgreSQL conversation adapter
implements the same conversation, message, and message-part contract. The
explicit PostgreSQL composition root combines it with the summary, context,
large-file, promoted-memory, recall, redaction-administration, lexical-search,
and coordination adapters behind one complete `ProjectStorage` contract.
The native-transcript repository adds immutable sanitized client-native
records, exact message provenance, atomic checkpoint accounting, and
idempotent ingest-key conflict handling. It intentionally exposes no payload
update or deletion operation. Embedded backfill code receives
`NativeTranscriptRepository` explicitly; both production project factories
expose the repository and an exact session-message snapshot through
`ProjectStorage.nativeTranscripts`. SQLite stores active native records in its
project database, separately from immutable canonical recovery archives. The production PostgreSQL factory, runtime, migration
runner, identity repository, and isolated test-database lease support the
daemon's selected project-storage routes. CLI/import-export and portable
transfer remain #618-owned, while aggregate stats, status, pool diagnostics,
and doctor parity remain #619-owned. Selecting `postgresql` never falls back to
SQLite. See
[PostgreSQL native transcripts](../src/storage/postgresql/reference/postgresql-native-transcripts.md) for the
local-scrubbing, checkpoint, quarantine, and rollback boundaries.
The issue #88 adapters implement the existing `ProjectRepositories` contracts
for promoted memory, recall, redaction administration, and coordination and
are included in the explicit PostgreSQL project-storage factory.
See [PostgreSQL memory and administration](../src/storage/postgresql/reference/postgresql-memory-administration.md)
for their metadata, concurrency, purge, and retention contract. Issue #90
extends the concrete staged `PostgreSqlCoordinationRepository` with distributed
work coordination without changing the backend-neutral SQLite contract:
transaction-scoped advisory locks, database-clock fenced leases,
same-transaction final fence validation, fair durable inbox claims, bounded cleanup,
and diagnostics. Long-running model or network work stays outside transactions;
only the final fence check and protected write share a short transaction. See
[PostgreSQL cross-machine coordination](../src/storage/postgresql/reference/postgresql-coordination.md).
Issue #91 adds a separate staged `PostgreSqlPassiveEventRepository` and drain
worker around that exact coordination contract. It inserts and reads the
existing inbox idempotently, completes an event effect and its `applied`
transition in one fenced transaction, schedules retry or quarantine, supports
exact replay, and prunes only exact applied rows after durable local
acknowledgement. It does not add a migration, queue, lock namespace, or normal
application routing.

### PostgreSQL runtime and migrations

One internal runtime owns one `pg` pool. It receives only the already-resolved
LCM settings: an explicit URL, CA file, pool bound, and acquisition, idle, SQL
statement, and idle-transaction timeouts. The URL cannot contain query or
fragment overrides, so `PG*` variables and connection-string TLS switches
cannot weaken the configured CA, hostname verification, UTC session, or
application identity. Queries accept parameter arrays without copying SQL or
values into public errors. Aborted active queries are cancelled by a bounded,
one-shot TLS client using the checked-out backend PID; an uncertain target
connection is destroyed rather than returned to the pool. Sanitized PostgreSQL
cancellation errors retain scoped project and machine identity while excluding
SQL text, query values, and driver details. Machine-owning coordination
operations and explicitly fence-bound summary, context, and shared-core
operations preserve that machine identity in query and transaction cancellation
context; a bound fence machine ID must be a UUIDv7, is accepted
case-insensitively, and is stored in canonical lowercase. Invalid fence
machine IDs fail synchronously during repository construction with a sanitized
`machine_id` data error that never serializes the supplied value. Deliberately
unfenced project readers remain machine-less. The
sanitization boundary continues to exclude SQL, bound values, raw driver
details, and transport metadata.

Ordered SQL files are packaged in `dist` and checked against an explicit
SHA-256 manifest before execution. The runner takes a database-scoped
transaction advisory lock, requires a UTF-8 PostgreSQL 18 database and the
current required extensions in the `public` schema, validates the complete
`lcm.schema_migrations` history, and rejects unknown, out-of-order, or
checksum-drifted entries. Pending SQL and its ledger row commit together, making
empty, repeated, concurrent, and failed runs deterministic. Extension
remediation is diagnostic only, including namespace correction, restoration of
missing control files, and `pg_stat_statements` preload/restart guidance; LCM
never changes cluster extensions. The migrator owns the `lcm` schema; `PUBLIC`
has no schema-create privilege in a supported database. Before ledger
inspection, the transaction connection must have
`session_replication_role = origin`; replica, local, missing, or malformed
session state fails before the advisory lock and every LCM schema or constraint
fingerprint. The runner does not reset this privileged per-session setting.
It permits an absent schema but rejects an existing schema
not owned by the current migration role; delegated `CREATE` is insufficient and
no ownership is changed automatically. Every run rejects a schema that grants
`PUBLIC CREATE` before ledger inspection without changing its ACL; the baseline
repeats the guard before its owned DDL. A catalog-only ledger relation
preflight permits absence on first installation; when
`lcm.schema_migrations` exists, it must be an ordinary table owned by the
current migration role. Views, materialized views, foreign tables, and every
other relation kind fail before any ledger-row query. Under the same lock,
every run also verifies that the current migrator still owns each known LCM table, identity
sequence, helper or trigger function, text-search dictionary, and text-search
configuration that exists before reading any ledger rows. This catalog-only
phase therefore returns structured ownership diagnostics before history is
trusted. Baseline completeness is evaluated after the applied history is
known. Unknown schema objects are outside that exact catalog allowlist and are
neither rejected nor changed.
Schema snapshots are keyed by migration ID and own both the exact managed
object inventory and definition fingerprints. The newest migration in
the trusted current ledger that has a registered snapshot is checked before
pending SQL, while the newest migration in the target history that has a
registered snapshot is checked after applying and recording the pending set but
before commit. Selection follows migration history rather than registry order.
The selected current snapshot verifies its managed inventory and definitions
before pending SQL; the selected target snapshot repeats both checks after
pending SQL and ledger writes, so a migration may add managed objects without
weakening the earlier contract. Definition checks cover the complete valid,
ready, and live index inventory attached to every managed table, non-internal
triggers, non-view rewrite rules, constraints, all 210 ordinary columns, stored
generated-column expressions, identity sequences, all 24 table persistence
states, the complete effective ACLs of the tables and sequences, and the exact
ACL state of all 225 ordinary and generated columns; indexes must remain
valid, ready, and live and inherit ownership from their tables. The current baseline
authority contains 94 managed-table indexes and explicitly requires zero
non-view rewrite rules. Identity-trigger
inventory requires always-enabled mode, rejecting disabled, ordinary, or
replica-only drift and enforcing checks under `session_replication_role =
replica`. Constraint inventory includes every supported constraint owned by a
managed table plus every foreign key that targets one. It binds owning and
referenced relation identities, canonical definitions, validation,
enforcement, locality, and inheritance state, together with canonicalized
definitions and enablement, internal, deferrability, and parentage metadata for
every enforcement trigger on either side of the constraint. Ordinary columns
retain type, nullability, default, identity, and resolved collation metadata;
generated columns retain their formatted type, nullability, generated state,
fully deparsed expression, and resolved collation. Both column fingerprints
also bind the sorted complete set of associated PostgreSQL 18 `NOT NULL`
constraints, including canonical identity plus validation, enforcement,
locality, and inheritance state, without increasing the column object count.
Tables must remain permanent with
row-level security neither enabled nor forced, and cannot participate in
inheritance or partition parent/child relationships.
Effective relation ACLs normalize the owner plus only the exact reviewed
identity-, conversation-, native-transcript-, and memory-runtime grant shapes. Added `PUBLIC`,
out-of-shape named-role privileges, foreign grantors, or grant options fail
closed while null and explicit owner-only defaults compare equally. Column ACL
fingerprints preserve every no-ACL identity and accept only the reviewed
column-limited runtime writes.
Identity sequences retain permanent persistence, allocation parameters,
internal dependency, and owning table/column. Migration transactions pin
`quote_all_identifiers = off` before catalog deparsing. Migration preflight and
every setting-sensitive runtime readiness statement also pin
`search_path = pg_catalog, public` transaction-locally before catalog
deparsing or type formatting; these settings do not leak into pooled sessions.
The pg_trgm readiness preflight closes the complete operator trust graph: it
authenticates each direct `gin_trgm_ops` mapping and then follows every
non-direct commutator and negator edge to its exact operator implementation,
estimator procedures, reciprocal pointer, extension membership, extension
owner, and dependency provenance. Built-in comparison operators are checked
with their null extension evidence and zero extension dependencies. Any
missing, duplicate, redirected, foreign-owned, or dependency-drifted indirect
edge fails closed as a sanitized extension-preflight error, without exposing
catalog identities or connection details to callers.
Any additional valid,
ready, and live index, non-internal trigger, supported constraint, generated
column, or ordinary column attached to a managed table, any foreign key
targeting one from another schema or relation, or any non-view rewrite rule
attached to one, is included in the complete inventory and fails closed.
`NOT NULL` constraints are represented by their owning column fingerprint so
they are not double-counted as PostgreSQL 18 `pg_constraint` rows; an
unvalidated or otherwise non-authoritative constraint is rejected even when
`attnotnull` remains true. Unknown
operator-created objects outside those managed-table boundaries remain outside
the inventory. That boundary remains fail-closed for repository writes: the
repositories address only the pinned managed relations; a new attached identity
sequence requires a new or changed managed ordinary column and is rejected by
the complete column inventory, while an unattached sequence cannot affect those
writes. Relation and column ACL sanctions remain scoped to the pinned managed
write surface because every managed column is inventoried before its ACL is
normalized. Non-internal triggers are enumerated directly; internal constraint
triggers are deliberately excluded there and instead fingerprinted completely
with their owning constraint.
`PUBLIC` has no privileges on the 24 explicitly listed LCM-owned tables, six
generated identity sequences, or the search-normalization, summary-identity,
large-file-identity, and session-ingest-identity functions; unknown
pre-existing object ACLs are preserved. The normalization function is created
without replacement, so a same-signature collision fails and rolls back the
pending migration rather than overwriting operator code. Baseline migrations
still grant no application privileges. An administrator applies the exact
reviewed scripts for the restricted runtime role, and the PostgreSQL factory
rejects construction unless the complete required grant set is present with no
overbroad managed-object privileges. Normalization-function ACL readiness accepts
only the owner plus non-`PUBLIC` runtime roles whose entries are
non-grantable, owner-granted `EXECUTE`; broader privilege shapes fail closed.
The three advisory-locked exact-identity triggers require `READ COMMITTED`
isolation so their post-lock residual query receives a fresh snapshot; they
fail closed under `REPEATABLE READ` and `SERIALIZABLE`. Recurring readiness
normalizes and compares every ACL entry on those functions and accepts only the
owning role's non-grantable `EXECUTE` privilege.

### Ownership and domain grouping

`StorageBackendFactory` owns resources shared by one configured backend, such as
connection-pool policy. Opening a project returns a `ProjectStorage` scope whose
repositories are bound to that project. Application code depends on these
interfaces, while the SQLite adapter alone owns `DatabaseSync`, migrations,
SQLite feature probes, FTS5 details, and connection pooling.

Persistent SQLite opens revalidate the database pathname immediately after the
SQLite handle opens and fail closed before changing file permissions or running
initialization PRAGMAs. A final identity comparison before pooling also covers
databases created by that open and rejects pathname changes detected during
initialization.

The project scope groups operations by domain:

| `ProjectStorage` repository | Responsibility |
| --- | --- |
| `conversations` | Conversation identity, message and message-part persistence, ordering, and deletion |
| `summaries` | Summary records and DAG lineage |
| `context` | Ordered context replacement, depth discovery, and token totals |
| `largeFiles` | Large-file metadata and retrieval |
| `promotedMemory` | Durable memory records, exact ordered tags, object metadata, confidence, archival, revival, and stale-candidate selection |
| `recall` | Surfacing history, feedback, and recall statistics |
| `lexicalSearch` | Backend-specific message, summary, and promoted-memory search with stable ordering, ranking, filtering, and fallback behavior |
| `redactionAdmin` | Additive redaction counters, readback, and atomic purge of repository-owned mutable project state |
| `coordination` | Completed-session ingest records and machine-scoped instruction-cache coordination |

The caller that opens a `ProjectStorage` owns it and closes it in `finally`.
Closing a project scope or factory is idempotent. Transaction-scoped
repositories are borrowed only for their callback and must not be retained.
Long-lived processes may retain a factory while opening short-lived project
scopes for requests; short-lived commands close both scopes and the factory
before exit. Closing one project scope must not invalidate another scope owned
by a concurrent request.

### Capabilities, health, and errors

Capabilities are explicit data, not behavior inferred by probing a repository.
Callers check them before requesting an optional operation. An unsupported
capability fails with a typed, sanitized error instead of silently changing the
algorithm or reaching into an adapter. Current capability data identifies
transaction, lexical-search, regular-expression-search, and full-text-search
support, plus whether coordination is local or distributed.

Health checks report whether the selected backend can serve repository
operations and identify the backend and affected domain. They do not return
connection URLs, credentials, certificate contents, filesystem database paths,
raw driver errors, SQL text, or bound values. Operation failures follow the same
rule: useful diagnostics may name the backend, project identity, and repository
domain, but secret-bearing and dialect-specific details remain inside the
adapter and logs' existing safety boundaries.
For PostgreSQL and SQLite, once factory shutdown begins, an in-flight factory
health probe reports only the closed state and exposes no project or runtime
detail, even if an underlying probe later settles healthy, unavailable, or
failed. Factory shutdown does not wait for otherwise unbounded health probes.
For PostgreSQL and SQLite, once project shutdown begins, project health reports
the closed state with the project identity and exposes no query detail, even if
its probe settles later. A failed SQLite project close clears the in-progress
close attempt and reopens the lifecycle latch for a later retry, even though
the pooled handle was already released; health may therefore be unavailable
between attempts.

### Transactions

Transactions are asynchronous callbacks on `ProjectStorage`:

```ts
await project.transaction(async (tx) => {
  const messages = await tx.conversations.createMessagesBulk(inputs);
  await tx.context.appendContextMessages(
    conversationId,
    messages.map((message) => message.messageId),
  );
  await tx.redactionAdmin.upsertCounts(counts);
});
```

The callback receives repositories bound to one transaction. Returning from the
callback commits atomically; throwing or rejecting rolls back the complete
callback and rethrows a sanitized operation error. A callback must not use the
non-transactional repositories from its outer `ProjectStorage` scope.

Nested transactions are rejected immediately and explicitly. They are not
implemented as savepoints, queued behind the outer transaction, or committed
independently. Repository and transaction objects never expose SQL handles, so
application code cannot accidentally bypass this boundary.

### Adding a repository operation

When a workflow needs a new persistence operation:

1. Add the smallest backend-neutral method to the appropriate domain contract.
   Describe inputs, outputs, ordering, idempotency, and transaction semantics;
   do not encode SQL or driver concepts in its types.
2. Implement it in the SQLite adapter while preserving current results, FTS
   fallback, isolation, and error behavior.
3. Add it to the reusable backend-conformance fixtures, including success,
   failure, ordering, project isolation, transaction, and close behavior where
   relevant.
4. Implement the same contract in every enabled adapter. PostgreSQL operations
   are added by the later PostgreSQL adapter issues before that backend is made
   available.
5. Route the consumer through `ProjectStorage` and await the operation. Keep the
   project scope's ownership and close point visible at the composition layer.

Do not add a generic query escape hatch to avoid updating an adapter. A missing
contract operation is an architecture change that must be implemented and
tested across adapters.

### Integration boundary

Issue #81 covers domain contracts, the SQLite adapter, transaction semantics,
and repository-backed SQLite composition paths. Bespoke SQLite import/export,
aggregate stats, status, connection-pool diagnostics, and administrative SQL
remain deliberately outside this runtime increment. Issue #616 defines the
versioned, backend-neutral portable record and resumable stream contract for
#618 import/export work; it is not a second daemon routing seam. New application
code still uses the selected `ProjectStorage` repositories.

### Local hook outbox exception

`LocalHookOutboxRepository` is an intentionally SQLite-only boundary. Hooks use
it to capture passive events quickly even when the daemon or authoritative
project backend is unavailable. A bounded daemon consumer reads the outbox,
promotes eligible events through the selected project's repositories, and marks
local entries processed only according to the existing retry rules. Each event also
has a versioned transport UUID, durable machine identity, installation-global
exact-`bigint` sequence, and local delivery checkpoint. Sequence reservation is
transactional and gap-safe.

The outbox is not a project-memory cache, a dual-write target, an offline read
replica, or a fallback source for repository reads. PostgreSQL outages must
remain visible to authoritative workflows; they do not authorize reads or
writes against a hidden SQLite copy of project memory. The outbox owns only
local event capture, local promotion state, delivery retry/checkpoints,
retention guards, health, and error-log operations, and it does not expose its
SQLite handle to callers.

Local promotion and remote delivery are independent state machines.
`processed_at` records local passive-learning consumption. Remote
`acknowledged_at` advances only after the PostgreSQL inbox proves `applied`.
Consequently, local promotion never suppresses replication, including for
processed rows upgraded from a legacy sidecar, and local retention never
discards an outage backlog. Processed rows are removable only after delivery
acknowledgement and exact remote-prune proof.

The staged drain performs network work outside hooks. A fenced lease admits one
local drain owner, but #90 `SKIP LOCKED` claims allow independent machines to
progress concurrently. A ready local sequence prefix prevents an unavailable
earlier event from being skipped before insertion. PostgreSQL then enforces the
authoritative per-machine claim order. Durable states—not process memory—form
the crash checkpoints:

```text
local pending/claimed/retry
  -> remote pending/claimed/retry
  -> remote applied or quarantined
  -> local acknowledged or quarantined
  -> exact remote applied-row prune
  -> local remote-pruned checkpoint
```

Uncertain insertion and applied commits require immutable readback. Remote
prune completion requires either a successful exact delete or missing-row
readback. A present nonterminal, mismatched, or quarantined row is never treated
as pruned. The worker and its operator CLI remain a separate explicit delivery
path; they do not replace or weaken #617's daemon project-storage routing.

### Portable durable file writes

`atomicWritePrivateFileDurable` has an intentionally narrow portable contract.
With `requireAbsent: true`, it fully writes, fsyncs, and mode-tightens a
temporary inode, then uses an exclusive same-directory hard link for durable
no-clobber creation. Without `requireAbsent`, it performs the bounded existing
file safety preflight and then publishes the completed candidate with an
unconditional same-directory atomic rename. The preflight rejects an unsafe,
oversized, non-regular, wrong-owner, or multiply linked destination, but it is
not a descriptor-relative mutation and does not close a same-UID replacement
race after the final check.

The helper rejects the legacy `expectedContentSha256` option, including when
its value is `null` or `undefined`, before opening the parent, creating a
temporary path, or writing. Callers that need conditional replacement must own
a protocol-specific operation and recovery grammar, such as the migration
manifest publication protocol. Application locks coordinate cooperating LCM
writers only; they cannot constrain an arbitrary same-UID, non-cooperating
editor. This contract therefore makes no portable pathname-CAS claim and
documents the remaining same-UID limitation explicitly.

## Data model

### Conversations and messages

One runtime session can map to multiple **conversation segments**. Explicit
creation starts a new segment; get-or-create finds the newest exact session
match and creates one only when none exists. Equal creation timestamps are
resolved by conversation ID, and concurrent PostgreSQL get-or-create calls for
the same project and session converge under an advisory lock. PostgreSQL
canonicalizes the project UUID before deriving that lock key, so equivalent
uppercase and lowercase UUID spellings cannot split the lock domain.

Messages are stored with:

- **seq** — Monotonically increasing sequence number within the conversation.
  Atomic append allocates contiguous values from `0`; explicit values remain
  available for replay and import. Explicit sequence values are nonnegative
  JavaScript safe integers.
- **role** — `user`, `assistant`, `system`, or `tool`
- **content** — Plain text extraction of the message
- **tokenCount** — Nonnegative safe-integer estimated token count
  (~4 chars/token)
- **createdAt** — Insertion timestamp

Each message also has **message_parts** — structured content blocks that preserve the original shape (text blocks, tool calls, tool results, reasoning, file content, etc.). This allows the assembler to reconstruct rich content when building model context, not just flat text.

Conversation lists use creation time then conversation ID; messages use
sequence; message parts use a nonnegative safe-integer ordinal stored as
PostgreSQL `bigint`. Message pagination treats `afterSeq` as
exclusive, an omitted or negative safe-integer limit as unlimited, zero as no
rows, and a positive safe integer as the result bound. Bulk message writes, atomic append
allocation, part writes, and multi-message deletion retain an operation-level
rollback boundary whether called directly, inside an existing repository
transaction, or from a same-handle `ConversationStore.withTransaction()`
callback that catches the operation failure and commits other work. Deletion
skips summarized messages, removes eligible message references from active
context, and relies on the owned-part cascade. Unbounded PostgreSQL batches
use a constant number of bind parameters and typed set-valued expansion rather
than one placeholder per input. Both adapters reject embedded U+0000 before
database access for every conversation-domain text input: session and title
values, session lookups, message content writes and exact-content lookups,
message-part text fields (including metadata), and message search queries where
supported. Part metadata is checked only for U+0000 and is otherwise preserved
as opaque text. Issue #85 preserves canonical message content
without claiming that every oversized post-normalization parser token is
lexically retrievable. The pinned PostgreSQL 18 safe parsed-lexeme maximum is
2,046 UTF-8 bytes; #89 must implement and test lossless handling at that
post-normalization boundary before PostgreSQL application writes are accepted.
PostgreSQL get-or-create and contiguous-append short transactions establish
`READ COMMITTED` before their first advisory or row lock on every retry, so a
stricter database default cannot retain a pre-lock snapshot and overlook the
winning session segment or newly appended sequence range.
When those contention methods join an existing transaction, they verify its
effective isolation is already `READ COMMITTED` before taking any advisory or
row lock and fail closed otherwise. Call them from an outer transaction begun
at `READ COMMITTED`, or use a root repository that creates the short
transaction itself; PostgreSQL cannot repair a stronger isolation level after
the outer transaction has already executed a statement. All scoped
conversation operations share one executor-level FIFO. Mapped writes,
bootstrap marking, and message-part insertion use the runtime's first-class
savepoint callback: the runtime owns generated savepoint identifiers and
control SQL, supplies a temporary inner query executor, drains its queue, and
uses async-context provenance to reject outer-executor or nested-savepoint use
from inside that callback. Independent sibling operations arriving while the
callback is active remain on the outer FIFO and run afterward; captured inner
executors are fenced when the callback settles. Only ordinary statement or
mapping failures can recover, and only after both `ROLLBACK TO` and `RELEASE`
succeed. Open, control, connection, and abort failures poison the outer
transaction so it rolls back. This prevents a read from observing a transient
row and prevents rollback from silently undoing another method whose promise
already resolved.
PostgreSQL `bigint` values are converted to JavaScript numbers only after a
safe-integer check. Decimal driver strings and native bigints are parsed and
range-checked as `bigint` before `Number` conversion, so malformed or
out-of-range identities, sequences, token counts, part ordinals, or counts fail
instead of rounding or losing precision. Message sequence, token-count, and
part-ordinal batches are fully validated before their first SQL statement.
Generated conversation and message identities are
mapped before their write transaction commits, so an unsafe identity rolls the
row back; generated message-part identities remain opaque UUID strings.

### The summary DAG

Summaries form a directed acyclic graph with two node types:

**Leaf summaries** (depth 0, kind `"leaf"`):
- Created from a chunk of raw messages
- Linked to source messages via `summary_messages`
- Contain a narrative summary with timestamps
- Typically 800–1200 tokens

**Condensed summaries** (depth 1+, kind `"condensed"`):
- Created from a chunk of summaries at the same depth
- Linked to parent summaries via `summary_parents`
- Each depth tier uses a progressively more abstract prompt
- Typically 1500–2000 tokens

Every summary carries:
- **summaryId** — `sum_` + 16 hex chars (SHA-256 of content + timestamp)
- **conversationId** — Which conversation it belongs to
- **depth** — Position in the hierarchy (0 = leaf)
- **earliestAt / latestAt** — Time range of source material
- **descendantCount** — Total number of ancestor summaries (transitive)
- **fileIds** — References to large files mentioned in the source
- **tokenCount** — Estimated tokens

### Context items

The **context_items** table maintains the ordered list of what the model sees for each conversation. Each entry is either a message reference or a summary reference, identified by ordinal.

When compaction creates a summary from a range of messages (or summaries), the source items are replaced by a single summary item. This keeps the context list compact while preserving ordering.

## Compaction lifecycle

### Ingestion

When Claude Code processes a turn, it calls the context engine's lifecycle hooks:

1. **bootstrap** — On session start, reconciles the JSONL session file with the LCM database. Imports any messages that exist in the file but not in LCM (crash recovery).
2. **ingest** / **ingestBatch** — Persists new messages to the database and appends them to context_items.
3. **afterTurn** — After the model responds, ingests new messages, then evaluates whether compaction should run.

### Leaf compaction

The **leaf pass** converts raw messages into leaf summaries:

1. Identify the oldest contiguous chunk of raw messages outside the **fresh tail** (protected recent messages).
2. Cap the chunk at `leafChunkTokens` (default 20k tokens).
3. Concatenate message content with timestamps.
4. Resolve the most recent prior summary for continuity (passed as `previous_context` so the LLM avoids repeating known information).
5. Send to the LLM with the leaf prompt.
6. Normalize provider response blocks (Anthropic/OpenAI text, output_text, and nested content/summary shapes) into plain text.
7. If normalization is empty, log provider/model/block-type diagnostics and fall back to deterministic truncation.
8. If the summary is larger than the input (LLM failure), retry with the aggressive prompt. If still too large, fall back to deterministic truncation.
9. Persist the summary, link to source messages, and replace the message range in context_items.

### Condensation

The **condensed pass** merges summaries at the same depth into a higher-level summary:

1. Find the shallowest depth with enough contiguous same-depth summaries (≥ `leafMinFanout` for d0, ≥ `condensedMinFanout` for d1+).
2. Concatenate their content with time range headers.
3. Send to the LLM with the depth-appropriate prompt (d1, d2, or d3+).
4. Apply the same escalation strategy (normal → aggressive → truncation fallback).
5. Persist with depth = targetDepth + 1, link to parent summaries, replace the range in context_items.

### Compaction modes

**Incremental (after each turn):**
- Checks if raw tokens outside the fresh tail exceed `leafChunkTokens`
- If so, runs one leaf pass
- If `incrementalMaxDepth != 0`, follows with condensation passes up to that depth (`-1` for unlimited)
- Best-effort: failures don't break the conversation

**Full sweep (manual `/compact` or overflow):**
- Phase 1: Repeatedly runs leaf passes until no more eligible chunks
- Phase 2: Repeatedly runs condensation passes starting from the shallowest eligible depth
- Each pass checks for progress; stops if no tokens were saved

Manual batch discovery applies the same eight-message fresh-tail boundary before
calling the daemon. A conversation with no raw messages outside that boundary is
already up to date, even when its protected messages exceed the batch token
threshold. When the daemon reports `actionTaken`, LCM promotes only projects
where it actually created a summary; explicit daemon no-ops are reported as
unchanged and do not trigger promotion. Older daemons that omit `actionTaken`
retain legacy success semantics, so a successful no-op response may still
trigger promotion for that project. Replay mode also admits conversations with
no leaf work outside the fresh tail when their existing in-context summaries
meet the manual condensation fanout and token thresholds. If an automatic
promotion request loses the local daemon transport after compaction, the
command runs the existing managed-daemon recovery contract, creates a fresh
client, and retries that project's promotion once. Application errors are not
retried, compaction is not replayed, and later projects retain independent
recovery opportunities. If promotion still fails, the command identifies the
affected project and exits with status 1 so automation does not mistake the
partial run for complete success.

**Budget-targeted (`compactUntilUnder`):**
- Runs up to `maxRounds` (default 10) of full sweeps
- Stops when context is under the target token count
- Used by the overflow recovery path

### Three-level escalation

Every summarization attempt follows this escalation:

1. **Normal** — Standard prompt, temperature 0.2
2. **Aggressive** — Tighter prompt requesting only durable facts, temperature 0.1, lower target tokens
3. **Fallback** — Deterministic truncation to ~512 tokens with `[Truncated for context management]` marker

This ensures compaction always makes progress, even if the LLM produces poor output.

## Context assembly

The assembler runs before each model turn and builds the message array:

```
[summary₁, summary₂, ..., summaryₙ, message₁, message₂, ..., messageₘ]
 ├── budget-constrained ──┤  ├──── fresh tail (always included) ────┤
```

### Steps

1. Fetch all context_items ordered by ordinal.
2. Resolve each item — summaries become user messages with XML wrappers; messages are reconstructed from parts.
3. Split into evictable prefix and protected fresh tail (last `freshTailCount` raw messages).
4. Compute fresh tail token cost (always included, even if over budget).
5. Fill remaining budget from the evictable set, keeping newest items and dropping oldest.
6. Normalize assistant content to array blocks (Anthropic API compatibility).
7. Sanitize tool-use/result pairing (ensures every tool_result has a matching tool_use).

### XML summary format

Summaries are presented to the model as user messages wrapped in XML:

```xml
<summary id="sum_abc123" kind="leaf" depth="0" descendant_count="0"
         earliest_at="2026-02-17T07:37:00" latest_at="2026-02-17T08:23:00">
  <content>
    ...summary text with timestamps...

    Expand for details about: exact error messages, full config diff, intermediate debugging steps
  </content>
</summary>
```

Condensed summaries also include parent references:

```xml
<summary id="sum_def456" kind="condensed" depth="1" descendant_count="8" ...>
  <parents>
    <summary_ref id="sum_aaa111" />
    <summary_ref id="sum_bbb222" />
  </parents>
  <content>...</content>
</summary>
```

The XML attributes give the model enough metadata to reason about summary age, scope, and how to drill deeper. The `<parents>` section enables targeted expansion of specific source summaries.

## Expansion system

When summaries are too compressed for a task, agents use `lcm_expand` to recover detail.

### How it works

1. An agent calls the daemon-backed `lcm_expand` MCP tool or `lcm expand <nodeId>` CLI command. Both use `POST /expand` with a `nodeId` and an optional positive-integer `depth` (default: `1`; no maximum).
2. LCM descends child links from the requested node for the requested number of levels. The response contains child and descendant summaries as snippets of up to 200 characters, together with `citedIds`. Results are accumulated for the requested levels rather than returned as a nested tree.
3. This HTTP surface does not request raw source messages and does not pass a token cap, so `LCM_MAX_EXPAND_TOKENS` does not apply to it. A leaf therefore contributes no source-message content.

The separate `buildExpansionToolDefinition` helper is an unregistered TypeBox tool definition and is not used by the shipped MCP server. If an integration registers that helper, it supports an explicit `tokenCap` and optional `includeMessages`, resolving the cap against the configured `maxExpandTokens` value (including `LCM_MAX_EXPAND_TOKENS`).

For broader recall, agents can first use `lcm_grep` or `lcm_search` to find relevant summary IDs, then call `lcm_expand` on the results that need more detail.

## Large file handling

Files embedded in user messages (typically via `<file>` blocks from tool output) are checked at ingestion:

1. Parse file blocks from message content.
2. For each block exceeding `largeFileTokenThreshold` (default 25k tokens):
   - Generate a unique file ID (`file_` prefix)
   - Store the content to `~/.lcm/projects/<project-hash>/files/<file_id>.<ext>`
   - Generate a ~200 token exploration summary (structural analysis, key sections, etc.)
   - Insert a `large_files` record with metadata
   - Replace the file block in the message with a compact reference
3. The `lcm_describe` tool can retrieve full file content by ID.

This prevents a single large file paste from consuming the entire context window while keeping the content accessible.

## Session reconciliation

LCM handles crash recovery through **bootstrap reconciliation**:

1. On session start, read the JSONL session file (Claude Code's ground truth).
2. Compare against the LCM database.
3. Find the most recent message that exists in both (the "anchor").
4. Import any messages after the anchor that are in JSONL but not in LCM.

This handles the case where Claude Code wrote messages to the session file but crashed before LCM could persist them.

## Operation serialization

All mutating operations (ingest, compact) are serialized per-session using a promise queue. This prevents races between concurrent afterTurn/compact calls for the same conversation without blocking operations on different conversations.

## Authentication

LCM needs to call an LLM for summarization. It resolves credentials through a three-tier cascade:

1. **Auth profiles** — Claude Code's OAuth/token/API-key profile system (`auth-profiles.json`), checked in priority order
2. **Environment variables** — Standard provider env vars (`ANTHROPIC_API_KEY`, etc.)
3. **Custom provider key** — From models config (e.g., `models.json`)

For OAuth providers (e.g., Anthropic via Claude Max), LCM handles token refresh and credential persistence automatically.
