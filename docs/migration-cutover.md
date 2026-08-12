# Reversible migration and cutover journal

LCM has a checksum-sealed protocol for future SQLite-to-PostgreSQL migration
and cutover workflows. It records what a migration generation intends to do,
which external effect is pending, and which immutable evidence was accepted at
each step. A private durable journal makes an interrupted protocol run
recoverable without guessing from timestamps or partially changed data.

This foundation does **not** copy data, activate PostgreSQL, change the current
storage backend, or execute rollback by itself. Later migration commands will
perform those effects and use this protocol to record their boundaries.

## Generations and storage witnesses

Every migration attempt has a bounded `generationId`. Its first manifest seals
two versioned storage witnesses:

- `source` identifies the SQLite generation from which data will be read.
- `destination` identifies the PostgreSQL generation to which data will be
  copied.

Each witness records the backend kind, identity, schema, and content as SHA-256
digests plus the capture time. The identity digest is evidence, not a database
role or authorization principal. Runtime and migration-role authority remains
an explicit configuration concern.

The manifest also retains a parent generation, the preserved source generation,
monotonic per-domain copy checkpoints, sanitized report references, and the
checksum of its immediate predecessor. Reports contain an ID, kind, checksum,
and time; report bodies and credentials do not belong in the manifest.

## Phases and effects

The complete phase vocabulary is:

`planned`, `dry-run-verified`, `copying`, `copied`, `verified`, `activating`,
`active`, `rolling-back`, `rolled-back`, and `aborted`.

Only the transitions below are legal. Beginning an effect creates a new
manifest revision with that effect pending; it does not claim that the target
phase has been reached. Completing the same effect creates another revision,
attaches its required evidence, clears the pending effect, and enters the
target phase.

| Current phase | Effect | Target phase | Required completion evidence |
| --- | --- | --- | --- |
| `planned` | `verify-dry-run` | `dry-run-verified` | one `dry-run` report |
| `dry-run-verified` or `copying` | `copy-batch` | `copying` | one monotonic checkpoint |
| `copying` | `complete-copy` | `copied` | no additional evidence |
| `copied` | `verify-generation` | `verified` | one clean `verification` report and activation eligibility |
| `verified` | `prepare-activation` | `activating` | no additional evidence |
| `activating` | `publish-activation` | `active` | one `activation` report |
| `verified` or `active` | `prepare-rollback` | `rolling-back` | no additional evidence |
| `rolling-back` | `publish-rollback` | `rolled-back` | one `rollback` report and `pre-write` or `post-write` rollback mode |
| `planned`, `dry-run-verified`, `copying`, `copied`, or `verified` | `abort` | `aborted` | one `abort` report |

Direct phase edits, skipped revisions, broken predecessor links, unknown
effects, duplicate report IDs, regressing checkpoints or timestamps, and
missing or surplus completion evidence are refused.

## Pending effects and authoritative readback

Pending effects are classified without inspecting live storage:

- `retry-idempotent` effects can be resumed from their sealed input.
- `authoritative-readback-required` effects require the later workflow to read
  the destination system and prove whether the external effect committed.

Copy and publication effects use authoritative readback because a lost process
or connection response cannot prove whether the destination changed. The
protocol never infers success from a phase name, elapsed time, or a local
exception.

When readback proves that `publish-activation` or `publish-rollback` did not
occur, the workflow may abandon that exact pending effect with a checksum-bound
`abandonment` report. Activation returns to `verified`. Rollback returns to the
`verified` or `active` phase sealed when rollback preparation began. Other
pending effects cannot use abandonment as a shortcut.

## Immutable journal layout

One migration generation is stored below the private LCM root:

```text
~/.lcm/migrations/<generation-id>/
  head.json
  revisions/
    <16-digit-revision>/
      <manifest-sha256>.json
```

Revision directories and all intermediate migration directories must be exact
mode `0700`. Manifest and head files must be exact mode `0600`, regular files,
owned by the expected user, and have exactly one link. Each file is limited to
1 MiB and contains canonical ASCII JSON terminated by a newline. Unknown
fields, noncanonical bytes, non-ASCII content, unsafe ownership or modes,
symlinks, hard links, and changed identities are rejected.

The manifest checksum covers every manifest field except the checksum itself.
`head.json` has its own canonical checksum and points to one revision number,
checksum, and checksum-derived filename. A revision is immutable once
published.

All create, update, and recovery mutations use the home-level private lock
`~/.lcm.migration-manifest.lock`. LCM authenticates the retained home topology
before taking that lock, restores the original home mode while working, and
revalidates the topology before returning. A manifest revision is fully
written and made durable before its containing directory is synchronized and
the head is published.

Head replacement is compare-and-swap. It is bound to the SHA-256 digest of the
exact bounded head bytes read while locked, independently of the manifest's
canonical checksum. If another writer or operator changes the head, the
replacement fails without overwriting those bytes.

## Crash recovery

Ordinary reads authenticate the head and its selected revision. If the exact
next numeric revision directory exists, the read returns `recovery-required`
instead of ignoring or choosing the orphan.

Recovery advances at most one step:

1. With an authenticated head, it inspects only `head.revision + 1`.
2. Without a head, it inspects only revision `0` for headless genesis recovery.
3. The expected directory must contain exactly one checksum-shaped manifest
   filename. That file must pass all ownership, mode, link, size, canonical
   checksum, generation, revision, filename, and predecessor checks.
4. The following numeric revision directory must be absent. Its presence is a
   forbidden second hop.
5. Recovery compare-and-swap publishes only the new head and returns the
   authenticated manifest.

Recovery never scans historical revisions, skips a number, chooses by time or
filename order, inspects live backend data, deletes an orphan, or rewrites
suspicious evidence. An absent candidate leaves an intact head unchanged. An
ambiguous, malformed, wrongly linked, unsafe, or multi-hop state fails closed
for operator investigation.

## Settled lineage

`active`, `rolled-back`, and `aborted` are settled only when no effect is
pending. Rolled-back generations retain the sealed return phase and whether
rollback occurred before or after destination writes. All settled generations
retain their immutable source lineage and report references.

Loading a settled record does not stat, hash, or otherwise revalidate a live
SQLite or PostgreSQL tree against its historical witness. Legitimate writes
after cutover therefore cannot make the historical manifest appear corrupted.
Any later rollback workflow must perform fresh authoritative checks at its own
effect boundary.

## Failure classifications

Callers receive a `MigrationProtocolError` with one sanitized reason:

- `invalid-input` — a caller supplied an invalid operation or creation value.
- `malformed-manifest` — persisted structure, canonical encoding, or path
  identity is inconsistent.
- `checksum-mismatch` — a manifest or head seal does not authenticate.
- `recovery-required` — one exact unpublished successor exists and ordinary
  reads must stop.
- `unexpected-state` — a legal operation cannot proceed from the authenticated
  state, including stale compare-and-swap input or ambiguous recovery evidence.

Filesystem and durability errors may also propagate when LCM cannot safely
classify them. Do not delete or edit journal evidence to silence a refusal.
Preserve the generation directory and use the later migration tooling's
diagnostic and recovery commands once those commands are available.

## Current rollout boundary

The protocol, reducers, durable store, and exact recovery primitive are now
available as the `src/migration` module for the remaining cutover work. Snapshot
capture, dry-run planning, batch copy, reconciliation, activation, rollback,
CLI commands, and end-to-end recovery remain separate deliverables. Until those
features land, normal installations continue using their existing storage
selection and should not manually create or mutate this journal.
