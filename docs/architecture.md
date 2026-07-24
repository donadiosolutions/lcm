# Architecture

This document describes how Long Context Manager (LCM) works internally — the data model, compaction lifecycle, context assembly, and expansion system.

## Storage selection

The daemon resolves one storage backend before opening its listener. SQLite is
the default and preserves the existing per-project database layout. PostgreSQL
is an explicit remote-primary selection whose production connection URL comes
from `LCM_POSTGRES_URL`; verified TLS uses the required
`LCM_POSTGRES_CA_FILE`. Trusted runtime overrides remain available to tests and
embedded callers and take precedence over the environment.
Configuration parsing, effective CLI output, doctor, daemon startup, and storage
construction share the same discriminated resolved configuration. This prevents
different entry points from applying different precedence or validation rules.

The internal PostgreSQL 18 runtime now provides a bounded `pg` pool, verified
CA and hostname validation, sanitized SQLSTATE errors, abort cancellation,
transactional migrations, extension readiness, and the complete durable schema
baseline. It is intentionally not constructed by the application storage
factory yet: a valid PostgreSQL selection still fails with an explicit
unavailable-backend error before the daemon listens. The domain adapters tracked
by #84-#91 must implement the shared repository contracts and pass conformance
before #92 can make PostgreSQL authoritative. The local SQLite hook outbox is
not a general cache and remains local after that activation. See the
[PostgreSQL schema reference](postgresql-schema.md) for table ownership,
integrity, indexes, retention, extension policy, and recovery implications.

## Storage repository architecture

LCM's application code accesses project memory through asynchronous domain
repositories. A repository describes what LCM needs to do—for example, create a
message, traverse summary lineage, or record recall feedback—without exposing a
SQL connection, statement, transaction object, placeholder syntax, or other
backend-specific primitive.

SQLite is the authoritative implementation of these contracts and remains the
zero-configuration default. The reusable conformance suite is backend-neutral,
while SQLite remains its only production adapter today. The PostgreSQL runtime,
migration runner, and isolated test-database lease are shared foundations; they
do not enable PostgreSQL by themselves. Until all PostgreSQL domain adapters and
rollout gates land, selecting `postgresql` continues to fail explicitly rather
than falling back to SQLite.

### PostgreSQL runtime and migrations

One internal runtime owns one `pg` pool. It receives only the already-resolved
LCM settings: an explicit URL, CA file, pool bound, and acquisition, idle, SQL
statement, and idle-transaction timeouts. The URL cannot contain query or
fragment overrides, so `PG*` variables and connection-string TLS switches
cannot weaken the configured CA, hostname verification, UTC session, or
application identity. Queries accept parameter arrays without copying SQL or
values into public errors. Aborted active queries are cancelled by a bounded,
one-shot TLS client using the checked-out backend PID; an uncertain target
connection is destroyed rather than returned to the pool.

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
inspection, the runner permits an absent schema but rejects an existing schema
not owned by the current migration role; delegated `CREATE` is insufficient and
no ownership is changed automatically. Every run rejects a schema that grants
`PUBLIC CREATE` before ledger inspection without changing its ACL; the baseline
repeats the guard before its owned DDL. Under the same lock, every run also
verifies that the current migrator still owns each known LCM table, identity
sequence, helper or trigger function, text-search dictionary, and text-search
configuration that exists before reading any ledger rows. This catalog-only
phase therefore returns structured ownership diagnostics even when the ledger
table itself has drifted to another owner. Baseline completeness is evaluated
after the applied history is known. Unknown schema objects are outside that
exact catalog allowlist and are neither rejected nor changed.
After the baseline is recorded, it also verifies the explicit existence and
canonical definitions of all allowlisted secondary indexes, triggers, and
constraints, plus every stored generated-column expression; indexes must remain
valid and ready and inherit ownership from their tables. Trigger inventory also
requires ordinary enabled mode, rejecting disabled, replica-only, or
always-enabled drift. Constraint inventory includes the enablement state of
its internal enforcement triggers, and generated columns retain both their
generated state and fully deparsed expression. Unknown operator-created
indexes, triggers, and constraints remain outside the inventory.
`PUBLIC` has no privileges on the 24 explicitly listed LCM-owned tables, six
generated identity sequences, or the search-normalization, summary-identity,
large-file-identity, and session-ingest-identity functions; unknown
pre-existing object ACLs are preserved. The normalization function is created
without replacement, so a same-signature collision fails and rolls back the
pending migration rather than overwriting operator code. Runtime domain grants
remain absent until their owning adapters land.
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

The project scope groups operations by domain:

| `ProjectStorage` repository | Responsibility |
| --- | --- |
| `conversations` | Conversation identity, message and message-part persistence, ordering, and deletion |
| `summaries` | Summary records and DAG lineage |
| `context` | Ordered context replacement, depth discovery, and token totals |
| `largeFiles` | Large-file metadata and retrieval |
| `promotedMemory` | Durable memory records, tags, confidence, archival, revival, and stale-candidate selection |
| `recall` | Surfacing history, feedback, and recall statistics |
| `lexicalSearch` | Backend-specific message, summary, and promoted-memory search with stable ordering, ranking, filtering, and fallback behavior |
| `redactionAdmin` | Redaction counters and the bounded administrative operations needed by normal workflows |
| `coordination` | Ingest checkpoints and other project-scoped workflow coordination |

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

### Staged integration boundary

Issue #81 covers domain contracts, the SQLite adapter, transaction semantics,
and repository-backed SQLite composition paths. Bespoke SQLite import/export,
aggregate stats, status, connection-pool diagnostics, and administrative SQL
remain deliberately outside this first migration. Issue #224 will route those
surfaces through backend-neutral workflows after the PostgreSQL domains and
conformance harness are complete. Their temporary SQLite implementation is not
permission for new application code to bypass repositories.

### Local hook outbox exception

`LocalHookOutboxRepository` is an intentionally SQLite-only boundary. Hooks use
it to capture passive events quickly even when the daemon or authoritative
project backend is unavailable. A later daemon pass reads the outbox, promotes
eligible events through the selected project's repositories, and marks local
entries processed only according to the existing retry rules.

The outbox is not a project-memory cache, a dual-write target, an offline read
replica, or a fallback source for repository reads. PostgreSQL outages must
remain visible to authoritative workflows; they do not authorize reads or
writes against a hidden SQLite copy of project memory. The outbox owns only
local event capture, retry, pruning, health, and error-log operations, and it
does not expose its SQLite handle to callers.

## Data model

### Conversations and messages

Every Claude Code session maps to a **conversation**. The first time a session ingests a message, LCM creates a conversation record keyed by the runtime session ID.

Messages are stored with:
- **seq** — Monotonically increasing sequence number within the conversation
- **role** — `user`, `assistant`, `system`, or `tool`
- **content** — Plain text extraction of the message
- **tokenCount** — Estimated token count (~4 chars/token)
- **createdAt** — Insertion timestamp

Each message also has **message_parts** — structured content blocks that preserve the original shape (text blocks, tool calls, tool results, reasoning, file content, etc.). This allows the assembler to reconstruct rich content when building model context, not just flat text.

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
promotion request fails after compaction, the command identifies the affected
project and exits with status 1 so automation does not mistake the partial run
for complete success.

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

1. Agent calls `lcm_expand` with a `nodeId` (summary ID) and optional `depth`.
2. lcm traverses the DAG from the given node, following parent links down to source messages.
3. Source message content is assembled and returned to the agent (capped by `LCM_MAX_EXPAND_TOKENS`).
4. The agent receives the full decompressed content for the requested depth.

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
