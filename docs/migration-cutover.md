# Reversible migration and cutover journal

LCM has a checksum-sealed protocol for future SQLite-to-PostgreSQL migration
and cutover workflows. It records what a migration generation intends to do,
which external effect is pending, and which immutable evidence was accepted at
each step. A private durable journal makes an interrupted protocol run
recoverable without guessing from timestamps or partially changed data.

This foundation does **not** copy data, activate PostgreSQL, change the current
storage backend, or execute rollback by itself. The immutable SQLite snapshot
capability adds the authenticated source artifact used by those later steps;
it still does not copy records into PostgreSQL or select a destination.

Compaction releases publication admission while waiting for a model and revalidates
it for each subsequent storage operation. A project handle uses that operation's
current token; it cannot reuse the expired token from opening the project. Daemon
health probes acquire their own fresh admission, so an idle model request does not
make storage unhealthy. Both paths still refuse access during a migration hold.

## Immutable SQLite preparation and capture

Migration preparation is an explicit upgrade action. For an enrolled machine,
it adopts the two private `migration_receipt_v1_` tables in each SQLite project
and records the first machine sequence for which passive-event effects must
commit with an exact receipt. Ordinary SQLite installations without a registered
machine continue to open and process events as before. They do not fabricate an
identity or epoch, and snapshot admission refuses their unproven history.

Snapshot capture and dry-run are strictly read-only with respect to the source.
LCM authenticates read-only, no-follow descriptors for the project database,
local event outbox, machine-sequence database, and each WAL or shared-memory
sidecar. Shared-memory bytes are stability evidence and are never published.
SQLite recovery, `quick_check`, schema inspection, UTF-8 admission, and
`user_version = 0` validation run only on private copied bytes. Capture never
opens the source through SQLite, checkpoints it, changes its mode, runs a source
migration, cleans a sidecar, or writes its directory.

Private raw database/WAL copies and normalized database artifacts are sealed to
read-only mode before their final file sync. A mode-change or final-sync failure
prevents publication of the committed snapshot marker.

Maintenance enters durably before capture. Hooks may keep appending to their
local outboxes throughout the hold, including after restart. Capture takes a
short local append barrier, authenticates fresh source bytes and a private copy
of the sequence checkpoint, and durably refreshes the held journal's cutoff and
byte commitment by exact-checksum compare-and-swap. The barrier remains held
through private artifact and queue-evidence sealing. Later hook events stay
beyond the sealed cutoff.
Project writers, promotion, delivery claims, correlation repair, processing
marks, replay, and destructive pruning remain fenced while maintenance is held.
The maintenance record survives restart and can leave the fence only through an
authoritative selected-generation readback or an explicit source-preserving
abort. Reports do not grant replay or prune authority.

The receipt contract deliberately refuses ambiguous legacy input. A receipt-era
event is represented only when its immutable envelope exactly matches an applied
or no-effect receipt from the same project transaction. A receipt-era pending
event with no receipt is retained for later guarded replay. A processed receipt-
era event without a receipt, an unknown machine, or any pre-epoch event refuses
cutover. Both processed and unprocessed legacy rows can fall on the historical
commit-before-`processed_at` crash boundary, so this refusal can be permanent.
LCM preserves the source and private evidence rather than guessing whether to
replay or suppress such an effect.

An established receipt epoch also proves that preparation created the
project's canonical local outbox. Capture therefore refuses an enrolled source
when that outbox is absent, even if the sequence cutoff is null or the outbox
was empty before it disappeared. Absence cannot prove an empty queue. A present
empty outbox remains valid, and older sources without enrollment can still be
inspected for the normal legacy refusal path. Capture never recreates a missing
outbox.

`captureAuthenticatedSqliteMigrationSource` returns an outer-ready snapshot with
its physical artifact, exact receipt reference, bounded queue page references,
and a checksum. It reauthenticates machine identity, project metadata, aliases,
configuration, and the held maintenance journal before sealing and returning.
The actual copied machine-sequence counter must equal the journal cutoff. The
currently supported participant set is the authenticated local machine; a shared
project or another participant without acknowledged fencing is refused.

Queue evidence is stored separately under
`~/.lcm/migration-evidence/<generationId>/`. Each immutable page contains at most
128 records and 128 KiB. The bounded index is at most 1 MiB; a generation admits
at most 100,000 queue or receipt rows. Receipt checksums and queue records are
hashed incrementally in canonical order. Capture never loads the entire queue
or receipt set to construct pages. Inputs beyond these limits are refused with
the source and partial generation preserved.

Use `inspectAuthenticatedSqliteMigrationSnapshot` to verify a previously sealed
outer-ready snapshot. Readback authenticates page identities and content and
recomputes the receipt and queue commitments from the immutable SQLite
artifacts. A copied replacement, malformed record, forged disposition, partial
page set, or changed request refuses reuse. A physical artifact reported as
complete by the lower-level artifact inspector has not, by itself, passed this
queue and receipt admission. Preserve both directories on failure and start a
new generation after the cause is resolved; do not repair a partial generation
by editing its files.

The canonical SQLite reader remains owned by the portable storage adapter.
Migration copy orchestration consumes the physical artifact alongside the
outer-ready receipt/page evidence; it must not create a second reader,
maintenance lock, or admission authority. Exact duplicate promotion attempts
reuse the committed receipt before repeating any decision or effect, including
recovery from a crash before the outbox processing mark.

| Source condition | Snapshot disposition |
| --- | --- |
| Enrolled receipt-era applied/no-effect event with exact envelope receipt | Represented |
| Enrolled receipt-era event at or below cutoff, unprocessed, without receipt | Retained pending replay |
| Event appended after the sealed cutoff | Retained in the local outbox |
| Legacy processed or unprocessed event | Refused as effect-ambiguous |
| Receipt-era processed event without receipt | Refused as integrity failure |
| Enrolled source with missing canonical outbox | Refused as integrity failure |
| Missing, pending, nonlocal, duplicate, or drifting machine authority | Refused |
| Disconnected participant without durable acknowledged fencing | Refused |
| Partial, replaced, or tampered generation | Refused; evidence preserved |

## How to use this today

These capabilities are programmatic preparation APIs; no migration CLI is
available yet. `prepareSqliteMigrationEnrollment` accepts the current project
and home directory plus a separately resolved PostgreSQL target configuration.
It uses the existing verified PostgreSQL identity service to register and read
back the machine, while SQLite remains selected. Remote work occurs outside the
publication lock. Finalization rechecks the original configuration and project
identity, then adopts the forward receipt epoch under writer admission and the
local append barrier. It never backfills ambiguous historical receipts.

Preparation also initializes or validates that project's local event outbox
before establishing its receipt epoch. An empty project needs no preliminary
hook or configuration file: its first hook can append durably after maintenance
is held. Ordinary SQLite project opens for a registered machine perform this
same preparation. Outbox connection opening and schema initialization share the
append barrier with capture, so they wait until a capture finishes. During the
hold, an absent or outdated outbox is refused; capture and dry-run never repair
it. Prepare the project successfully before authenticating its source and
entering maintenance.

Successful enrollment publishes the registered machine identity only after the
canonical project store, local outbox, sequence allocator, and receipt epoch are
durable for that exact PostgreSQL identity. If local SQLite preparation fails,
`machine.json` remains pending. A retry reuses an already committed exact epoch
before it exposes the machine identity, including when identity publication was
the interrupted step. Hooks captured while the identity is still pending remain
unregistered legacy evidence and can still make migration refuse ambiguity;
enrollment does not backdate an epoch or reclassify those events.

A caller authenticates the SQLite source and source bytes, then enters held
maintenance through the existing backend publication coordinator. The initial
roster contains the verified machine, its last allocated sequence (or null
before allocation), and the authenticated source-byte evidence. A later call to
`captureAuthenticatedSqliteMigrationSource` acquires its own append barrier;
callers need not retain a process-local token across maintenance or restart.
The supplied checksum must match the durable held journal; fresh evidence is
bound at capture only while the physical generation remains absent.
Configuration, source selection, machine identity, or participant drift refuses
capture. The APIs are exported by the `src/migration` module for the later
migration orchestrator.

Capture returns the refreshed maintenance checksum in
`artifact.maintenanceChecksumSha256` and the exact source-byte commitment in
`artifact.sourceByteWitnessSha256`; its source role witnesses are
`artifact.roles[].source`. Retain these with the generation for exact retries.
An existing complete artifact is reused only with its original authority,
maintenance checksum and source-byte witness. A retry never refreshes a partial,
complete, replaced or tampered generation to fit later source bytes.

If capture fails after refreshing the journal but before creating any generation
intent, read the durable held journal again, reauthenticate source bytes under
the append barrier, and retry with that journal's checksum and commitment. Fresh bytes may include later legal appends: an absent generation has not yet
frozen its capture-time commitment. The exact generation and source-selection
authority must still match the durable hold. Once any generation intent exists, preserve its files
and use explicit abort followed by a new generation. An interrupted
`maintenance-entering` can be resumed with the exact original request and the
observed `expectedChecksumSha256`, or explicitly aborted with matching source
selection and abort evidence. Completed selection and authenticated abort
journals are archived byte-for-byte before a subsequent generation begins.

Normal installations retain their existing storage selection. Do not manually
create, edit, delete, or otherwise mutate the journal or its lock file. Preserve
the physical and queue evidence directories when preparation refuses a state.

## Configuration

There are currently no user-configurable options for this protocol or its
store. The journal home path is derived from LCM's normal runtime home. The
private layout, exact file modes, and 1 MiB file-size bounds are fixed safety
policy, not configuration options, and must not be changed manually.

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
owned by the expected user, and normally have exactly one link. The one accepted
transitional exception is an interrupted atomic publication where the exact
final and writer-scratch names are two hard links to the same authenticated
inode. This applies to both a manifest revision and `head.json`; arbitrary hard
links remain invalid. Each file is limited to 1 MiB and contains canonical
ASCII JSON terminated by a newline. Unknown fields, noncanonical bytes,
non-ASCII content, unsafe ownership or modes, symlinks, unrelated hard links,
and changed identities are rejected.

The manifest checksum covers every manifest field except the checksum itself.
`head.json` has its own canonical checksum and points to one revision number,
checksum, and checksum-derived filename. A revision is immutable once
published.

All create, update, and recovery mutations use the home-level private lock
`~/.lcm.migration-manifest.lock`. LCM authenticates the retained home topology
before taking that lock, restores the original home mode while working, and
revalidates the topology before returning. A manifest revision is fully
written and made durable before its containing directory is synchronized and
the head is published. Immutable revision directories are append-only recovery
evidence and must not be pruned or archived out of the generation. A crash can
leave only the sealed publication attempt and the committed head; in that row,
LCM reconstructs the exact prior version-1 head from the retained predecessor
revision before it removes the final attempt marker.

Head replacement is compare-and-swap. It is bound to the SHA-256 digest of the
exact bounded head bytes read while locked, independently of the manifest's
canonical checksum. If another writer or operator changes the head, the
replacement fails without overwriting those bytes.

## Crash recovery

Ordinary reads authenticate the head and its selected revision. If the exact
next numeric revision directory exists, the read returns `recovery-required`
instead of ignoring or choosing the orphan.

An empty next revision directory or one containing only an authenticated
writer scratch file means content publication had not completed. Recovery
preserves that pre-content state and returns the intact current head without
advancing it; the caller must retry the same create or update operation to
finish publication. Without an existing head, the same incomplete revision `0`
state has no recoverable manifest, so recovery returns `unexpected-state` and
the caller must retry creation. Recovery publishes a head only for a complete,
authenticated manifest that is also a legal genesis or immediate protocol
successor.

Recovery advances at most one step:

1. With an authenticated head, it inspects only `head.revision + 1`.
2. Without a head, it inspects only revision `0` for headless genesis recovery.
3. The expected directory must contain exactly one checksum-shaped manifest
   filename. At most one authenticated, checksum-bound atomic-writer scratch
   file may coexist with it after an interrupted write. If both names exist,
   they must be the exact two-name, same-inode writer state described above;
   separate single-link files are invalid. The manifest and scratch must pass
   their ownership, mode, link-topology, and size checks; the manifest must also
   pass canonical checksum, generation, revision, filename, and predecessor
   checks.
4. The following numeric revision directory must be absent. Its presence is a
   forbidden second hop.
5. Recovery compare-and-swap publishes only the new head and returns the
   authenticated manifest.

Recovery never scans historical revisions, skips a number, chooses by time or
filename order, inspects live backend data, deletes an orphan, or rewrites
suspicious evidence. An absent candidate leaves an intact head unchanged. An
ambiguous, malformed, wrongly linked, unsafe, or multi-hop state fails closed
for operator investigation.

An exact `head.json` plus `.head.json.<24-hex>.tmp` same-inode writer pair is
also preserved by ordinary reads and no-op recovery. When an update or a
manifest-bearing successor recovery is ready to mutate that head, the exact
authenticated scratch alias is identity-consumed and the containing directory
is synchronized immediately before the next head mutation. Cleanup failure
therefore occurs before any successor revision is staged, while a replacement
or other mismatch preserves the pair as evidence whenever possible for a later
retry.

The durable writer can also stop after synchronizing its exclusive
`.head.json.<24-hex>.tmp` file but before linking or renaming it to `head.json`.
That single-link temporary file is incomplete publication evidence, not a
committed head. When an older authenticated `head.json` still exists, reads
continue to authenticate that old head but report `recovery-required` if the
temporary names its already-published immediate successor. Without a head, the
temporary must name the exact immutable genesis revision. The temporary's
canonical head seal, generation, revision, manifest checksum, timestamp,
owner, mode, single-link topology, size, and bytes must all remain bound to
that legal immutable revision. Malformed, mismatched, multiply linked, or
unaccompanied temporary evidence fails closed and is preserved.

An exact create retry, update retry, or recovery operation identity-consumes
the authenticated single-link temporary and synchronizes the generation
directory before attempting another head publication. A retry update still
reports `recovery-required` when the immutable successor already exists;
recovery then advances that exact successor. This prevents both pre-link and
pre-rename crash windows from permanently wedging the generation while keeping
ambiguous journal evidence available for operator investigation.

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

Issue #621 provides only the protocol, reducers, durable store, and exact
recovery primitive in the internal `src/migration` module. The later #622–#628
deliverables cover snapshot capture, dry-run planning, batch copy,
reconciliation, activation, rollback, CLI/operator commands, and end-to-end
recovery. Until those features land, normal installations continue using their
existing storage selection and should not manually create or mutate this
journal.
