# PostgreSQL cross-machine coordination

Issue #90 adds distributed coordination primitives to the staged
`PostgreSqlCoordinationRepository`. Issue #91 builds the staged passive-event
delivery repository and drain worker around those primitives. Together they
coordinate direct programmatic callers that share one PostgreSQL 18 database:

- transaction-scoped advisory locks for short serializable decisions;
- database-clock fenced leases for work that spans transactions;
- final fence validation for committing a protected result;
- ordered, durable claims from `passive_event_inbox`;
- idempotent inbox insertion and authoritative readback;
- atomic apply, retry, quarantine, replay, and applied-row pruning; and
- bounded lease cleanup and project-scoped diagnostics.

This feature does not change SQLite coordination, select PostgreSQL through
`ProjectStorage`, automatically start the drain worker, or activate PostgreSQL
for normal daemon data routes. Those routes remain gated by #92 and #224.
The `lcm events` status, validation, quarantine, and replay commands are staged
operator surfaces only.

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
- `SELECT` and `DELETE` on `passive_event_inbox`;
- inserts only for the immutable envelope columns (`project_id`, `machine_id`,
  `event_id`, `event_version`, `machine_sequence`, `event_type`, and
  `payload`);
- updates only to status, attempt, retry, claim, applied, and quarantine
  transition columns; and
- `USAGE`, but not `SELECT` or `UPDATE`, on
  `passive_event_inbox_inbox_id_seq`.

It grants no schema creation, table ownership, `TRUNCATE`, sequence restart,
payload update, immutable-envelope update, or unrelated table access. PostgreSQL
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
passes cancellation to the bounded runtime query path. A PostgreSQL
`lock_timeout` result is retryable so callers can back off; cancellation and
permanent failures remain non-retryable. Errors identify only the operation,
project, and machine; they do not expose the resource key, SQL, bound values,
URL, or credentials.

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
New acquisitions refresh their database timestamps after any uniqueness wait.
Time-dependent takeover, renewal, and fence checks first lock the exact lease
row, then read `statement_timestamp()` in a following statement. Time spent
waiting on another transaction therefore counts against the lease instead of
reusing a timestamp captured before the wait.

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

## Passive-event delivery and completion

`PostgreSqlPassiveEventRepository` wraps the #90 coordinator rather than
creating a second queue, lock namespace, fencing scheme, or diagnostics layer.
Insertion accepts at most 500 versioned envelopes at a time. Each envelope has
one machine UUID, event UUID, positive version, exact `bigint` machine sequence,
event type, and JSON-object payload. `ON CONFLICT DO NOTHING` is followed in
the same transaction by authoritative readback. A matching row proves
idempotent delivery; a missing row or any immutable collision fails closed.

The drain lease uses resource type `passive-events`, the worker machine UUID as
the resource key, and operation `replicate`. The worker renews the lease before
claiming and before each applied transition. Claims continue to use #90's
database ordering, stale-claim recovery, `SKIP LOCKED`, and project scoping.

For a claimed event, `completeApplied`:

1. validates the exact lease fence in a short `READ COMMITTED` transaction;
2. locks and revalidates the exact claimed inbox row;
3. calls the supplied effect callback with that same transaction executor; and
4. records `applied` and its timestamp before the transaction commits.

An effect cannot commit separately from the applied transition. Application
failure rolls both back. When the caller loses the commit response, it reads
the exact event back: `applied` proves the commit; the same live claim may be
retried or quarantined; any other owner or state is left untouched.

Retries use database time and bounded exponential delay. Poison events become
inspectable `quarantined` rows at the configured attempt boundary. Exact
machine/event replay returns only that row to `pending`; it never bulk-replays
or discards a quarantine. An earlier quarantine is terminal for #90 ordering,
so later events from the same machine may progress while the poison row remains
available for inspection and explicit replay.

Local insertion failures caused by a structured, deterministic envelope or
idempotency error identify the exact event. At the same bounded attempt
threshold, only that local row is quarantined so a collision cannot block the
machine forever; other rows from the batch retry. Connectivity and uncertain
readback failures are not treated as poison and continue retrying without data
loss.

## Local acknowledgement and remote pruning

Hooks never contact PostgreSQL. They append a versioned envelope to the local
SQLite outbox and return. Local passive-learning processing (`processed_at`) is
independent from remote delivery acknowledgement: promoting an event locally
cannot prevent it from being replicated later.

After remote `applied` readback, the worker durably commits the local
`acknowledged` checkpoint. Only acknowledged rows are candidates for exact
remote pruning, and the delete matches project, inbox ID, machine ID, event ID,
and `status = 'applied'`. The local `remote_pruned_at` checkpoint advances only
after the delete succeeds or a missing-row readback proves an earlier uncertain
delete committed. A remaining, mismatched, retryable, or quarantined row is
never reported as pruned.

The worker's durable checkpoints are the local delivery state and the remote
inbox state. A process crash therefore needs no in-memory recovery log:

- stale local and remote claims are reclaimed after their configured interval;
- uncertain insertion is resolved by immutable envelope readback;
- uncertain apply is resolved by exact status readback;
- uncertain remote pruning is resolved by missing-row readback; and
- local acknowledgement always precedes remote deletion.

Backoff is bounded and jittered. Batches are bounded. Different machines may
progress concurrently, while each machine retains #90's sequence ordering.

## Staged operator commands

These commands require `storage.backend` to be `postgresql`, a registered
machine, and a project with a remote PostgreSQL binding:

```bash
lcm events status [--json]
lcm events validate [--limit 100] [--json]
lcm events quarantine [--limit 100] [--json]
lcm events replay <event-id> [--machine <machine-id>] [--json]
```

`status` combines local delivery counts with #90 coordination diagnostics.
`validate` compares local replicated or quarantined envelopes with exact
PostgreSQL readback and exits unsuccessfully for missing or mismatched rows.
`quarantine` is bounded and read-only across local and PostgreSQL rows.
`replay` changes one exact local or remote quarantined row, advancing the local
checkpoint before a remote transition so an interrupted command remains
recoverable. None of these commands starts the worker or activates normal
PostgreSQL daemon routing.

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
