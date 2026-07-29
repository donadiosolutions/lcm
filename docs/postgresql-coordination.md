# PostgreSQL cross-machine coordination

Issue #90 adds distributed coordination primitives to the staged
`PostgreSqlCoordinationRepository`. They coordinate direct programmatic callers
that share one PostgreSQL 18 database:

- transaction-scoped advisory locks for short serializable decisions;
- database-clock fenced leases for work that spans transactions;
- final fence validation for committing a protected result;
- ordered, durable claims from `passive_event_inbox`;
- bounded lease cleanup and project-scoped diagnostics.

This feature does not change SQLite coordination, select PostgreSQL through
`ProjectStorage`, start a background worker, or activate PostgreSQL for normal
daemon and CLI data routes. Those routes remain gated by #92 and #224. Event
completion and acknowledgement remain owned by #91.

## Provision runtime access

Apply the schema with the migration owner first. Then apply the dedicated grant
script as an administrator:

```bash
psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file docs/postgresql-runtime-coordination-grants.sql
```

Replace `lcm_runtime` with the existing restricted runtime role. The script
grants:

- schema `USAGE`;
- `SELECT` and `DELETE` on `fenced_leases`;
- only the lease columns used by acquisition, takeover, renewal, and release
  for `INSERT` and `UPDATE`;
- `USAGE`, but not `SELECT` or `UPDATE`, on
  `fenced_leases_fencing_token_seq`;
- `SELECT` on `passive_event_inbox`;
- updates only to `status`, `attempt_count`, `claimed_at`, and `claimed_by`.

It grants no schema creation, table ownership, `TRUNCATE`, sequence restart,
inbox insert/delete, payload update, or unrelated table access. PostgreSQL
privileges are not row-level authorization: LCM is a single-user,
multi-machine system, and the runtime role is trusted for the database.
Repository methods still bind every operation to one validated project UUID,
so application callers cannot accidentally coordinate another project.

After changing grants, rerun `lcm postgres migrate` with the migration role.
Readiness accepts this exact non-grantable privilege shape and rejects broader,
`PUBLIC`, foreign-grantor, or grant-option privileges.

## Transaction locks

Use `acquireTransactionLock` only from a live
`PostgreSqlRuntime.transaction` callback. It takes
`pg_advisory_xact_lock`, so PostgreSQL releases the lock automatically on
commit, rollback, cancellation, connection loss, or process crash. There is no
manual unlock operation and no session-scoped lock.

The lock name is deterministic and project-scoped. LCM canonicalizes the
project UUID, adds the fixed resource namespace, and SHA-256 digests the
arbitrary resource key. Conversation, redaction-counter, and session-ingest
call sites use this same key derivation, preserving their schema-trigger
format. The namespace accepts only lowercase letters, digits, and hyphens so
callers cannot create ambiguous lock families.

Supply a positive `timeoutMs` and optionally an `AbortSignal`. LCM applies the
timeout transaction-locally, restores the prior setting after acquisition, and
passes cancellation to the bounded runtime query path. Errors identify only
the operation, project, and machine; they do not expose the resource key, SQL,
bound values, URL, or credentials.

Keep the transaction short. Do not call a model, provider, remote service, or
other unbounded operation while holding the lock.

## Fenced lease lifecycle

Use a lease when work must continue outside a database transaction:

1. Call `acquireLease` with a resource type/key, process ID, operation, and
   positive TTL.
2. If it returns `null`, another unexpired owner holds the resource. Back off;
   do not perform the protected work.
3. Perform model, network, or other expensive work outside a transaction.
4. Renew only when needed, using the exact owner, operation, and returned
   `bigint` fencing token.
5. Open a short transaction, call `assertLeaseFence`, and make the protected
   write in that same callback.
6. Discard the external result if fence validation fails.
7. Release with the exact owner, operation, and token when the operation is
   complete.

PostgreSQL `statement_timestamp()` is the authority for acquisition, renewal,
expiry, release, inspection, takeover, stale-claim recovery, and cleanup.
Application-host clocks do not decide ownership.

An expired or released row can be taken over. Takeover replaces the owner,
allocates a new identity-sequence fencing token with `DEFAULT`, and never
reuses the previous token. Renewal cannot revive an expired lease. A stale
owner cannot renew or release its successor because every mutation matches the
project, resource, owner machine, owner process, operation, and exact token.
Tokens are JavaScript `bigint`; never coerce them to `number`.

`assertLeaseFence` requires a live `READ COMMITTED` transaction and executes a
matching `SELECT ... FOR UPDATE`. That validation and the protected write must
be in the same short transaction. Validation before external work is not a
substitute: the lease can expire or be taken over while that work is running.

## Passive-inbox claims

`claimPassiveEvents` returns durable claim records whose `inboxId` and
`machineSequence` are `bigint`. One transaction:

- considers ready `pending` and `retry` rows plus `claimed` rows older than the
  supplied stale-claim interval;
- requires every earlier sequence for that machine to be terminal
  (`applied` or `quarantined`);
- orders eligible heads deterministically;
- locks candidates with `FOR UPDATE OF event SKIP LOCKED`;
- records the claim owner and database time; and
- increments `attempt_count`.

At most one eligible head exists per machine, while unrelated machines and
projects can progress independently. Concurrent claimers skip rows already
locked by a peer, cannot claim the same row twice, and cannot bypass an
earlier nonterminal sequence. A crashed claimant leaves a durable `claimed`
row; after the configured stale interval, another worker can reclaim that
same head and the attempt count increases.

Issue #90 deliberately does not add event completion APIs or a long-running
consumer. Until #91 lands, direct callers must use the owning staged workflow
to mark a claim applied, retryable, or quarantined while preserving the schema
status/timestamp invariants.

## Inspection, cleanup, and recovery

`listLeases(limit)` returns a bounded, deterministic project view with
`active`, `expired`, or `released` state. `getCoordinationDiagnostics()` returns
exact `bigint` lease and inbox counts plus the oldest relevant timestamps.
These are operational snapshots; ownership decisions still occur in the
mutating transaction.

For a read-only operator snapshot, bind the project rather than removing the
scope predicate:

```sql
\set project_id '018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020'

SELECT resource_type, resource_key, owner_machine_id, owner_process_id,
       operation, fencing_token, acquired_at, renewed_at, expires_at,
       released_at,
       CASE
         WHEN released_at IS NOT NULL THEN 'released'
         WHEN expires_at <= statement_timestamp() THEN 'expired'
         ELSE 'active'
       END AS state
FROM lcm.fenced_leases
WHERE project_id = :'project_id'::uuid
ORDER BY expires_at, resource_type, resource_key
LIMIT 100;

SELECT status, count(*) AS event_count, min(next_attempt_at) AS oldest_ready_at,
       min(claimed_at) AS oldest_claimed_at
FROM lcm.passive_event_inbox
WHERE project_id = :'project_id'::uuid
GROUP BY status
ORDER BY status;
```

`cleanupLeases({ retentionMs, limit })` deletes at most `limit` expired or
released rows older than the database-clock retention threshold. It uses
`FOR UPDATE SKIP LOCKED`, scopes every delete to the repository project, and
returns a project-scoped record whose `deletedCount` is exact `bigint`.
Cleanup never truncates the table or resets the fencing-token sequence, so
future tokens remain monotonic even after rows are removed.

After a process or connection failure:

1. Do not attempt a manual advisory unlock; transaction locks disappear with
   the failed session.
2. Treat the lease as owned until database time reaches `expires_at`.
3. Acquire normally after expiry. A successful takeover returns a larger
   fencing token.
4. Discard any late result carrying the predecessor token.
5. Inspect leases and queue diagnostics before cleaning old rows.

Malformed database rows, unsupported transaction isolation, invalid text,
unsafe numeric mappings, and cancelled operations fail closed with sanitized
storage errors. They should be investigated rather than retried by mutating
tables or sequences manually.
