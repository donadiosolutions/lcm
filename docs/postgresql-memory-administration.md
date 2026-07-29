# PostgreSQL promoted memory, recall, and administration

Issue #88 adds staged PostgreSQL 18 repository adapters for promoted memory,
recall feedback, redaction administration, and session coordination. These
adapters are available to programmatic callers and the shared repository
conformance suite. They do not activate PostgreSQL for normal daemon or CLI
storage routes: SQLite remains the default, and PostgreSQL application routing
remains gated by issues #92 and #224.

## Runtime grants

Apply the packaged schema as the migration owner, then apply the memory grant
script as an administrator:

```bash
psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file docs/postgresql-runtime-memory-grants.sql
```

Replace `lcm_runtime` with the restricted application role. The script is
transactional and grants only:

- schema `USAGE` and exact execution of `lcm.normalize_search_text(text)`;
- reads and project-scoped deletion on the six owned mutable-state tables;
- column-limited inserts and updates for repository-writable fields; and
- `USAGE`, but not `SELECT` or mutation, on the recall and instruction identity
  sequences.

It grants no schema creation, ownership, `TRUNCATE`, migration-ledger access,
generated-column writes, arbitrary project reassignment, or access to
conversation, summary, transcript, lease, inbox, or outbox data. PostgreSQL
readiness accepts this exact non-grantable owner-issued shape and fails closed
on broader privileges.

## Promoted memory

`PostgreSqlPromotedMemoryRepository` implements insert, read, list, content
prefix, update, archive, revive, delete, and stale-candidate operations within
one explicit project UUID.

- Tags retain order, duplicates, case, empty strings, and surrounding
  whitespace. PostgreSQL stores them as normalized rows but returns the exact
  original array.
- Metadata is an object-valued JSON document. Both SQLite and PostgreSQL reject
  arrays, primitives, malformed persisted JSON, non-finite or unsafe numbers,
  cycles, accessors, symbol keys, embedded U+0000, and unpaired surrogates.
  Inputs are copied before asynchronous work so later caller mutation cannot
  alter a pending write.
- Confidence remains in `[0,1]`, depth is a nonnegative safe integer, and
  content must be nonempty.
- `sourceProjectId`, `sourceSummaryId`, and `sessionId` are preserved as
  textual provenance; they do not create cross-project foreign keys.
- Archive, revive, metadata/tag replacement, and FTS-derived state changes are
  atomic. PostgreSQL-generated UUIDv7 identifiers are returned only after a
  root transaction commits. Canonical imported UUIDs of other versions,
  including SQLite UUIDv4 memory identifiers, remain addressable and retain
  their identity.
- Returned timestamps are canonical UTC ISO 8601 strings on both backends.

An omitted or negative content-prefix limit is unbounded, zero returns no rows,
and a positive safe integer applies the bound. Stale selection preserves the
existing policy: only sufficiently old active memories with no recorded use
qualify, either after the configured surfacing threshold or without any
surfacing. Ranking and lexical retrieval remain owned by issue #89.

## Recall feedback

`PostgreSqlRecallRepository` records every surfaced identifier, including
duplicates and identifiers that do not currently resolve to promoted memory.
Feedback returns surfacing count, usage count, and last surfacing time for every
requested identifier.

Usage evidence retains the SQLite rule: an active promoted record tagged
`signal:memory_used` counts the first ordered `memory_id:<id>` tag only.
Statistics report distinct surfaced identifiers, distinct identifiers acted
upon, bounded precision, and the five most-used references with deterministic
tie ordering. Aggregation is project-scoped and uses set-valued parameters
rather than a placeholder per input.

## Redaction counters and scoped purge

`PostgreSqlRedactionAdminRepository` adds validated additive counters, counter
readback, and one atomic project purge. Counter inputs must be nonnegative safe
integers; every field is validated before a write, zero-only updates are
no-ops, and concurrent increments use a project advisory lock plus one
`ON CONFLICT` update. The projected fields and aggregate total must remain safe
JavaScript integers, so an overflow attempt rolls back without changing state.

`purgeProjectState()` deletes only the mutable state owned by issue #88:

- promoted memories and their ordered tags;
- recall surfacing history;
- redaction counter rows;
- completed session-ingest rows; and
- session instruction-cache rows.

SQLite also removes the corresponding promoted-memory FTS mirror. PostgreSQL's
generated search document disappears with its source row. The operation
returns exact affected-row counts and runs in one root transaction or one
scoped savepoint. If any table delete fails, all earlier deletes roll back.

The purge deliberately retains project and machine identity, conversations,
messages, summaries, native transcripts, transcript checkpoints, passive-event
state, leases, and local hook outboxes. It is not project deletion, tenant
erasure, automated retention, or a change to redaction policy.

## Session coordination

`PostgreSqlCoordinationRepository` binds instruction rows to one project and
machine. Instruction IDs map to nonnegative slots; reads prefer the current
machine's requested slot and may fall back to the explicitly requested legacy
project-wide slot. Writes never overwrite another machine's cache.

Completed session ingestion uses a SHA-256 candidate key plus the exact session
text residual. Writers establish `READ COMMITTED`, take the same
project/session advisory lock as the schema trigger, and update or insert after
the lock. Concurrent writers therefore converge on one exact row. A caller
joining an existing PostgreSQL transaction must already be at `READ COMMITTED`;
stronger isolation fails closed before the savepoint write.

## Failure and isolation guarantees

Every query binds the repository project UUID and uses parameterized values.
Invalid UUIDs, unsafe integers, malformed metadata, unsupported text, malformed
timestamps, and unsafe database counts fail as sanitized storage-operation
errors. Arbitrary promoted-memory lookup IDs remain null/no-op operations
instead of reaching a PostgreSQL UUID cast.

Shared conformance tests cover SQLite parity. The isolated PostgreSQL 18 harness
additionally covers the reviewed grants, exact project isolation, concurrent
counters, concurrent session ingestion, purge affected counts, retained
out-of-scope data, removal of derived search state, and rollback after a
deliberately denied late purge step.
