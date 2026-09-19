---
"@donadiosolutions/lcm": patch
---

Refuse to complete a PostgreSQL migration copy whose canonical rows changed
after verification. Completion now re-reads every row the run wrote from
inside the transaction that commits it, and holds the project write fence for
that whole transaction, so another writer can no longer modify or delete a
verified row in the window between the check and the commit. Completing a run
costs one extra batched read per 500 rows it wrote, and other writes to the
same project wait for that completion to commit.

Let installations that have already run a transfer apply the schema upgrade
this check needs. The transfer ledger retains its rows, so the new required
digest column is added nullable, backfilled for rows written before it
existed, and only then made mandatory. A run that still carries one of those
older rows fails closed instead of completing unverified.

Report the readback failure that actually caused a migration settlement
attempt to fail, instead of a stale error left over from an earlier retryable
or ambiguous-commit attempt.
