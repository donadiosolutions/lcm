# PostgreSQL summaries, context, and large files

Issue #87 adds staged PostgreSQL repositories for the summary DAG, active
context projection, and large-file metadata. The adapters are available for
direct programmatic use and backend-neutral conformance testing. They do not
select PostgreSQL for normal daemon or CLI routes; application activation and
data movement remain owned by issues #224 and #92.

The three independently constructible adapters are:

- `PostgreSqlSummaryRepository`;
- `PostgreSqlContextRepository`; and
- `PostgreSqlLargeFileRepository`.

They implement the existing `SummaryRepository`, `ContextRepository`, and
`LargeFileRepository` contracts without changing SQLite behavior or the shared
method signatures.

## Provision runtime access

Apply migrations with the migration owner first, then apply the dedicated
runtime grants as an administrator:

```bash
psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file src/storage/postgresql/reference/postgresql-runtime-summary-context-grants.sql
```

Replace `lcm_runtime` with the existing restricted application role. The
script grants only the reads, column-limited inserts, context deletion and
ordinal update, and normalization-function execution used by these three
repositories. It grants no schema creation, object ownership, `TRUNCATE`,
sequence access, graph deletion, unrestricted update, grant option, or access
to future tables.

The summary and context repositories also use conversation and message rows.
Apply the
[conversation repository grants](postgresql-runtime-conversation-grants.sql)
when the same role creates those source records. A caller that binds a fenced
lease to summary or context mutations must additionally apply the
[coordination grants](postgresql-runtime-coordination-grants.sql), because
final-fence validation locks the exact lease row in the mutation transaction.

After changing grants, rerun `lcm postgres migrate` with the migration owner.
Readiness accepts only the registered, non-grantable privilege shape and fails
closed on broader or missing privileges.

## Identity and scope

Every repository instance is bound to one validated project UUID. Every
conversation, message, summary relationship, context item, and large-file row
also carries its conversation and project scope in PostgreSQL. A lookup never
falls back to another project or conversation.

Caller-supplied summary and file IDs are opaque, exact, unbounded text. The
schema computes a SHA-256 candidate so B-tree lookups stay bounded, then the
repository applies an exact text residual predicate. A digest match is never
treated as identity by itself. PostgreSQL UUIDv7 `summary_key` and `file_key`
values remain internal relationship and ordering keys and are not exposed
through the backend-neutral records.

JavaScript-facing PostgreSQL `bigint` values are converted only when they are
within the safe-integer range required by the shared contracts. Malformed,
fractional, or out-of-range values fail with a stable data error instead of
being rounded. Dates must remain valid PostgreSQL timestamps. Text containing
U+0000 is rejected before database access.

`summary_large_files` deliberately stores historical opaque file IDs rather
than foreign keys to `large_files`. IDs may be unresolved, may identify a file
from another conversation, and may repeat. Retrieval preserves the caller's
exact array order and duplicates.

## Summary creation and relationship writes

`insertSummary()` inserts the summary and its ordered file-reference array in
one transaction. A failure in either write rolls back the complete summary.
Defaults for depth and descendant counters match the SQLite repository.

Message coverage and parent edges are set-oriented mutation operations:

- every requested source message must exist in the same project and
  conversation as the summary;
- every requested parent must exist in that same scope;
- self-edges and duplicate or conflicting relationships are rejected;
- a parent edge that would make the graph cyclic is rejected; and
- one invalid element rolls back the entire call.

The repository never repairs, drops, redirects, or partially retains an
invalid edge. Direct source deletion remains governed by the deferred schema
relationships described in the
[schema reference](postgresql-schema.md#table-contracts).

Reads order source messages and parents by their stored ordinal. Child lists
use the parent's stored edge order with bounded internal-key tie-breakers.
Conversation and recent-summary lists use explicit timestamp and internal-key
tie-breakers so equal timestamps cannot make results nondeterministic.

## Recursive expansion

`getSummarySubtree()` uses a recursive CTE that walks from a requested root
toward its children. Results are ordered by depth and edge path. In a
multi-parent DAG, a summary reachable by more than one path is returned once:
the first deterministic path owns its `parentSummaryId`, `path`, and
`depthFromRoot` projection. `childCount` counts distinct direct outgoing
children.

The database trigger prevents new cycles, but traversal is still bounded by
the project and conversation of the requested root and de-duplicates results.
An operator who imported or restored damaged data must repair it through a
reviewed forward migration; the repository does not silently hide or delete
damaged edges.

Expected plans use:

- `summaries_identity_lookup_idx` for exact summary-ID candidates;
- `summary_parents_parent_idx` and `summary_parents_summary_idx` for both DAG
  directions;
- `summary_messages_message_idx` and `summary_messages_summary_idx` for
  coverage;
- `summary_large_files_summary_idx` for ordered file references; and
- the conversation-order indexes for bounded project/conversation lists.

## Context operations

Context ordinals are zero-based and contiguous for each conversation.
`appendContextMessage()`, `appendContextMessages()`, and
`appendContextSummary()` serialize against all graph and context writers for
that conversation, allocate one contiguous suffix, validate every referenced
row, and commit atomically. An empty message batch is a no-op.

`replaceContextRangeWithSummary()` treats `startOrdinal` and `endOrdinal` as an
inclusive range. It requires:

- safe, nonnegative ordinals with `startOrdinal <= endOrdinal`;
- a complete existing contiguous range;
- a replacement summary owned by the same project and conversation; and
- no concurrent change between validation, replacement, and resequencing.

The transaction removes that complete range, inserts the summary at its start,
and resequences the remaining projection to `0..n-1`. Missing endpoints,
gaps, cross-scope summaries, and uniqueness conflicts roll back every delete
and insert. Partial replacement is never reported as success.

`getDistinctDepthsInContext()` returns ascending distinct summary depths. Its
optional exclusive ordinal bound is normalized according to the shared
contract. `getContextTokenCount()` adds message and summary token counts and
fails instead of rounding a result beyond JavaScript's safe-integer range.

## Conversation locks and fenced writes

Every summary-graph and context mutation takes the same transaction-scoped
advisory lock introduced by issue #90:

```text
<lowercase project UUID>:conversation:<sha256(decimal conversation ID)>
```

The TypeScript repository and the always-enabled cycle trigger both use that
exact `conversation` namespace and resource key. This serializes parent,
coverage, summary-file, append, and replacement decisions without creating a
parallel lock family. PostgreSQL releases the lock automatically on commit,
rollback, cancellation, connection loss, or process crash.

Repository construction can bind an optional fenced-lease owner and `bigint`
token for protected mutations. When bound, the repository validates the
active, unexpired lease for the method's exact conversation after taking the
conversation lock and before changing rows. Validation uses `SELECT ... FOR
UPDATE` in the same short transaction as the write. A token for another
conversation, owner, operation, expired lease, released lease, or predecessor
owner fails the whole mutation. The cycle trigger is defense in depth and is
not a substitute for this final-write fence.

Do not hold these transactions while calling a model, provider, filesystem, or
remote service. Perform expensive work before the final fenced mutation, and
discard its result if fence validation fails.

## Stable failures

The staged adapters expose sanitized PostgreSQL-specific error classes for:

- malformed or unsafe data;
- a required summary, conversation, message, or file that is not found;
- duplicate, cyclic, stale-fenced, cross-scope, or otherwise conflicting
  writes; and
- normalized database-operation failures.

Errors retain the backend, project, domain, and operation fields used by the
storage error contract. They do not include SQL text, bound values, opaque
identifiers, connection URLs, or credentials. Serialization failures and
deadlocks may be retried only by the repository's bounded short-transaction
policy; an ambiguous commit is never replayed automatically.

## Migration and integrity diagnostics

Forward migration `0005_summary_context_integrity.sql` validates existing
summary relationships before installing the recursive cycle guard. It aborts
if it finds a scoped child or parent orphan, scope mismatch, self-edge, or
cycle. Existing unique constraints and schema-snapshot readiness protect edge
ordinals from duplicates independently of the `0005` data preflight. The
migration never deletes or rewrites existing graph data. The guard is an
`ENABLE ALWAYS` trigger, so `session_replication_role = replica` cannot bypass
it, and `PUBLIC` cannot execute its function.

Before applying the migration to restored or manually loaded data, inspect one
project/conversation at a time:

```sql
\set project_id '018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020'
\set conversation_id 42

WITH RECURSIVE reach(origin_summary_key, current_summary_key) AS (
  SELECT edge.summary_key, edge.parent_summary_key
  FROM lcm.summary_parents AS edge
  WHERE edge.project_id = :'project_id'::uuid
    AND edge.conversation_id = :'conversation_id'::bigint
  UNION
  SELECT reach.origin_summary_key, edge.parent_summary_key
  FROM reach
  JOIN lcm.summary_parents AS edge
    ON edge.project_id = :'project_id'::uuid
   AND edge.conversation_id = :'conversation_id'::bigint
   AND edge.summary_key = reach.current_summary_key
)
SELECT origin_summary_key, current_summary_key
FROM reach
WHERE origin_summary_key = current_summary_key
ORDER BY origin_summary_key, current_summary_key
LIMIT 100;

SELECT ordinal, item_type, message_id, summary_key
FROM lcm.context_items
WHERE project_id = :'project_id'::uuid
  AND conversation_id = :'conversation_id'::bigint
ORDER BY ordinal;
```

Treat any returned cycle or non-contiguous context projection as damaged data.
Stop writers, retain a database backup, and diagnose the source of the
unreviewed import or manual mutation. Do not disable the trigger, change it to
ordinary enablement, use replica mode, or delete edges opportunistically.

After migration or restore, run `lcm postgres migrate` again to verify the
ledger, managed-object snapshot, definitions, ACLs, trigger enablement, and
extension contract. Then run the isolated PostgreSQL 18 conformance harness
before activating any direct caller.

## Rollback and recovery

Repository calls are transactional. A normal error requires no manual row
cleanup. On connection loss around commit, inspect durable state through exact
project/conversation predicates before retrying; do not infer success from a
local timeout.

Schema rollback is forward-only. Never edit or remove released migration
files, and never rewrite `0002_schema_baseline.sql`. If `0005` reveals
pre-existing damage, restore the pre-migration backup, repair the source
process, and prepare a reviewed forward data repair before rerunning the
migration. Once `0005` is applied, any future schema change must use the next
unused migration number and update the managed snapshot registry.
