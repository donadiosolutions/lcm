# Reversible migration and cutover journal

LCM has a checksum-sealed protocol for future SQLite-to-PostgreSQL migration
and cutover workflows. It records what a migration generation intends to do,
which external effect is pending, and which immutable evidence was accepted at
each step. A private durable journal makes an interrupted protocol run
recoverable without guessing from timestamps or partially changed data.

This document explains the mechanism. To run a migration, use the operator runbook,
[Migration operations](migration-operations.md), which covers the `lcm migration` commands, their
exit classes and refusals, and the maintenance hold they leave in place.

The journal and immutable capture do not copy data or change the selected
backend by themselves. The internal bounded copy API described below consumes
those artifacts. Copy completion does not activate PostgreSQL or execute
rollback.

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

An ordinary SQLite open first proves that no object name or target belongs to
the `migration_receipt_v1_` namespace. With that proof, a missing, pending, or
damaged optional `machine.json` does not block the unenrolled project. LCM leaves
the identity file unchanged and does not create an outbox, sequence allocator,
or receipt epoch. Bounded-file integrity failures such as an oversized identity
file still refuse the open. Any receipt namespace evidence requires a valid
registered identity, including partial or malformed evidence, and explicit
migration preparation and capture remain strict. A valid registered identity
still enrolls a project whose receipt namespace is proven absent. Use `lcm
machine show` to inspect identity state and the existing `lcm machine recover
<machine-uuid> --force` flow to replace a damaged identity explicitly; do not
delete or reset receipt evidence.

Snapshot capture and dry-run are strictly read-only with respect to the source.
LCM authenticates read-only, no-follow descriptors for the project database,
local event outbox, machine-sequence database, and each WAL or shared-memory
sidecar. Shared-memory bytes are stability evidence and are never published.
SQLite recovery, `quick_check`, schema inspection, UTF-8 admission, and
`user_version = 0` validation run only on private copied bytes. Capture never
opens the source through SQLite, checkpoints it, changes its mode, runs a source
migration, cleans a sidecar, or writes its directory.

These snapshot and queue-evidence APIs require a callable process UID lookup
and a descriptor namespace that supports enumeration plus authenticated
directory traversal. LCM proves traversal through retained directory
descriptors before using descriptor-relative paths; it does not fall back to
ordinary pathnames. A platform without those capabilities is refused with
`SqliteSnapshotError` reason `unsupported-platform` after input validation and
before source opens, locks, artifact or evidence writes, queue iteration, or
callbacks. Classification and inspection also refuse missing UID capability,
including for an otherwise absent generation. On a supported platform, a
missing home or generation still classifies as absent. If the descriptor
namespace becomes unavailable while checking whether a private mutation-lock
owner disappeared, recovery fails closed instead of consuming its retry.

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
Authenticated capture validates its authority, source-byte witness, maintenance
checksum, home directory, and generation before checking process UID and retained
descriptor support. Dry-run validates its home directory before the same
capability check. Either wrapper reports an unsupported platform before capture
enters the append barrier or dry-run reads configuration, project, machine, or
source authority. Ordinary descriptor probe and cleanup failures remain snapshot
I/O errors. The lower-level snapshot calls repeat capability admission so a
capability lost after wrapper preflight is still refused before source access.
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

## Activation evidence, selection bindings and replay admission

Rollback decides what to unwind from durable evidence, so activation writes
that evidence in a fixed order:

1. Before the activation prepares its maintenance selection, it records, in
   this order, its epoch, its attempt, its witness, and the binding of that
   witness.
2. After the maintenance selection completes, and before the coordinator
   prepares the backend publication (the PostgreSQL configuration and the
   project map entry that binds the project to its PostgreSQL id), it records
   the selection binding. The binding is written **before** the publication is
   prepared because preparing archives the maintenance journal that the
   binding is derived from.
3. The coordinator then publishes the backend publication durably.

A crash while the publication is in flight leaves an activation that has to
be resumed or aborted before anything else; rollback refuses to start over
it. A completed publication without a recorded selection binding means
PostgreSQL is live, so rollback refuses (`published-but-unbound`) until the
activation records its binding. An installation with no activation
evidence and no completed publication is *unactivated*: it has nothing to
unwind, so rollback refuses it (restore the configuration to SQLite or run
`lcm migration abort`).

Replay admission (the check that routes a replayed append to SQLite or
PostgreSQL after a cutover or a rollback) follows the durable authority in
this order: a live maintenance of the generation that has not finished
refuses; the generation's selection bindings decide (the latest by manifest
revision; an activation selects PostgreSQL, a rollback selects SQLite); with
no selection recorded, a manifest at `rolled-back` is refused
(`unexpected-state`): no supported path leaves a rolled-back generation
without its selection binding, and re-running the rollback restores the
binding from its stored report, after which the binding decides; the generation's own terminal maintenance journal decides while
the coordinator has not archived it; everything else refuses. Between the
coordinator archiving the maintenance journal and the manifest settling,
admission refuses until the resume completes.

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

### Upgrading LCM during a migration

The portable schema digest changes in the release that adds
`conversations.parent_session_id`. Copy manifests, verification reports and
cutover proof manifests that were produced by an older LCM bind the old
digest and fail closed with `incompatible-schema` under the new binary.
Finish or abandon an in-flight migration before upgrading, then rerun it with
the new binary.

## Bounded migration copy and resume

The internal migration API copies one authenticated SQLite generation into an
explicit, separately provisioned PostgreSQL project. It requires the existing
journal to be `dry-run-verified`, `copying`, or `copied`; it does not prepare a
machine, create a project, generate a dry-run report, or select PostgreSQL.
Only the acknowledged local machine roster is supported. Shared source
identities, legacy receipt history, additional instruction databases, and
archive layouts that cannot preserve the local physical identity are refused.
The current single-project database includes its `session_instruction_cache`
rows. The absence witness describes only additional instruction databases.

The internal `src/migration/index.ts` entry point provides
`inspectSqliteMigrationCopy` and `runSqliteMigrationCopy` for the migration
composition root. These are not new CLI commands or package exports. Inspection
returns the source and destination witnesses needed by an independently verified
dry-run journal; it does not attest that a dry-run passed.

```typescript
const result = await runSqliteMigrationCopy({
  generationId: preparedGenerationId,
  homeDir,
  settings: explicitTargetSettings,
  expectedOwner: targetMigrationRole,
  expectedIdentity: enrolledTargetIdentity,
  ownerProcessId: workerProcessIdentity,
  maxRecords: 100,
  maxBytes: 8 * 1024 * 1024,
  leaseTtlMs: 300_000,
  maximumTransactionAttempts: 3,
  signal: cancellationSignal,
});
// result.phase === "copied"; separate verification and activation still follow.
```

The generation must already have authenticated capture/receipt evidence and a
verified dry-run journal. `expectedIdentity` includes the target UUID as both
`id` and `remoteProjectId`, captured physical `localProjectId`, enrolled
`machineId`, and the captured `canonical` and `selectedPath`. The returned result
contains generation/run IDs, immutable evidence hashes and domain counts, with
no source payloads or connection credentials.

Callers supply the generation and home directory, explicit target connection
settings and expected schema owner, enrolled target identity, process owner,
and batch limits. A batch contains 1–500 records and at most 150,994,944 framed
bytes. Empty domains still receive a terminal checkpoint. Lease TTL is an
integer from 1,000 through 86,400,000 milliseconds, defaulting to 300,000.
The per-operation transaction/recovery budget is 1–10, defaulting to 3.
Use the same batch limits when resuming a pending effect: its exact batch and
predecessor are immutable, and a different batch is a conflict.

The copy worker takes the project-wide `migration-copy` / `copy` lease.
PostgreSQL checks its database-clock fence at both ends of each data transaction.
An unresolved storage-publication lease blocks copy through normal project
admission, including when that publication lease has expired. A copy lease
never grants selection or activation authority.

The copy also binds its writers to the cluster it probed. Every writer
connection -- including a reconnect after an uncertain commit -- and every
destination transaction compares the live PostgreSQL system identifier with the
value recorded in the manifest's destination witness, and refuses with
`destination-conflict` before writing anything when they differ. This covers
the lease transactions that acquire, renew and release the copy lease (each
checks the identifier first, in its own transaction, separate from the data
transaction) and the readback transactions (checked before the lease
serialization lock). An endpoint that starts resolving to a different cluster
after the probe therefore receives no lease, data or receipt writes, even if
that cluster presents the same five-field identity witness.

Each local pending effect is durable before its destination mutation. Even a
successful COMMIT response must be followed by exact durable receipt readback
before the local checkpoint advances. A lost response keeps the effect pending;
recovery serializes with the original transaction and accepts only the exact
run, immutable batch receipt, and checkpoint. Unavailable or conflicting proof
cannot advance progress. Cancellation likewise leaves recoverable evidence;
retry the same generation after resolving the reported condition.

An ordinary destination-probe failure -- connection refusal, TLS negotiation,
or schema mismatch -- is collapsed into an evidence-free `MigrationCopyError`
with a fixed message and no attached cause, reason code, or payload. Only
`PostgreSqlCommitOutcomeUnknownError` (an uncertain commit) is rethrown
unsanitized so its own authoritative-readback recovery path can run. "Retry
the same generation after resolving the reported condition" therefore means
resolving the condition through the caller's own outer logging or destination
diagnostics, not through any detail carried on `MigrationCopyError` itself;
the error intentionally carries none, to avoid leaking destination-connection
detail into the migration journal or its callers.

`copied` means all 22 domains have terminal checkpoints and the destination's
actual canonical content was compared before durable transfer completion.
That comparison runs inside the completing transaction while it holds the project
publication fence; see [Canonical backend transfer](portable-transfer.md).
It does not mean the separate migration verification or activation steps have
run. SQLite remains selected, maintenance stays held, and retained or newly
appended post-cutoff events remain available for the later workflow. Keep the
private snapshot, receipt/queue evidence, migration journal and destination
transfer receipts until the full cutover lifecycle authorizes their removal.

Witness recipe version 1 is shared with preparation and later verification.
It binds the physical source, normalized paths, participant roster, immutable
capture and queue/receipt roots, portable manifest, and explicit destination
identity/schema/location. Changing that recipe invalidates an existing dry-run
journal; a caller must not substitute new witnesses into a partially copied run.

For recipe version 1, `checkpointBytes` in a batch-commit witness is the exact
UTF-8 text returned by decoding `serializePortableCheckpoint(checkpoint)`.
Its UTF-8 encoding must reproduce those canonical bytes exactly. It is not a
parsed checkpoint object or an additional hash. This encoding clarification
makes the byte witness representable by the canonical JSON hash function,
which intentionally refuses typed arrays.

### Copy cost and the publication fence

Every checkpoint publish re-proves source authority under the held
publication token before the local journal advances: the copy worker
re-authenticates the source path, re-reads the maintenance journal, and fully
re-inspects and re-hashes the authenticated snapshot artifact, then repeats
the authenticate and journal read once more to close the window opened by
that awaited re-inspection. This is deliberate fencing behavior, not an
optimization gap left to be tidied up later: it is what lets a checkpoint
publish trust that the source has not changed since it was captured, and
removing any part of it would reopen a real window for the artifact to be
tampered with or replaced between the check and the publish.

Because of this, copy cost scales with the number of checkpoint publishes
times the authenticated artifact's size, not with domain count alone: a
22-domain copy with `maxRecords: 1` measured 46 of these full re-proofs in a
single run, and they alone accounted for roughly 59% of that run's own wall
time. That figure is a floor, not a ceiling. It came from a minimal
`maxRecords: 1` fixture; the re-hash term grows with the artifact's actual
byte size while the rest of the copy loop does not, so a realistically sized
source database will spend a larger share of its copy time here, not a
smaller one.

Whether that re-proof can be made cheaper without weakening the fence -- for
example an incremental or generation-scoped witness that still leaves the
held publication token, authority bytes, maintenance journal bytes and phase,
and snapshot bytes all provably unchanged -- is an open question tracked in
[issue #1369](https://github.com/donadiosolutions/lcm/issues/1369). It is not
part of this API's current contract.

## Migration verification and canonical reconciliation evidence

A copied generation is not activation-eligible on its own. Verification reads
the immutable source snapshot and the live PostgreSQL destination once more,
independently of the copy worker's own evidence, and produces a durable,
content-addressed report before any activation step may consider the
generation. The report is bound to the exact source, destination, manifest,
schema and project-map witnesses in play, plus the sealed queue-classification
witness; changing any of those mints a different report identity rather than
silently reusing an unrelated one.

Publication requires two things together, not a clean report alone: every
reconciliation class must have actually run, and no class may have produced a
mismatch. The persisted report carries both facts directly, so this is
provable from the artifact itself rather than assumed by a reader. Its
`classCoverage` field records, for every defined reconciliation class,
whether that class ran this pass; its `activationEligible` field is
`true` only when every class ran, both public probes ran **and** the report
is clean.

"Ran" is earned, not declared. Each class and probe is marked as run only
when the comparisons behind it returned during this pass (a completion
receipt per comparison group), so a comparison that was never invoked leaves
its class marked not run, the report is still written, and it is not
activation-eligible. The receipts are plain identifiers and carry no time,
duration or ordering, so the report stays deterministic. A report can
therefore be clean -- zero recorded mismatches -- and still not be
activation-eligible, because a class that never ran produces no mismatches
for the same reason an unplugged smoke detector never sounds. Every reconciliation class this driver defines is now implemented
(`relation` and `ledger` were the last two), so a genuinely clean report
against a sound destination is activation-eligible. A refusal or a
mismatch in any class -- including a `relation` edge-set disagreement or
a `ledger` inconsistency -- still keeps `activationEligible` false, and
that fact is recorded in the report rather than left to be assumed. Any mismatch in any class,
including a `sample`-class mismatch from the public-listing probe, refuses
eligibility outright -- a sample mismatch that were merely recorded without
refusing would be exactly as decorative as a witness nobody compares.

A report **with** mismatches is still persisted in full as operator
evidence, but no effect is begun for it. Recovering from a report with
mismatches means explicit `abort` followed by a new generation, the same
pattern used throughout this journal for a phase that cannot be resumed in
place: verification does not retry itself, patch the destination, or narrow
the report to a smaller domain and try again. The mismatch evidence exists so
an operator can diagnose what diverged before starting over, not so the same
generation can be coerced into passing.

### What a refusal means

Verification refuses outright, before any report is written, when:

- the destination's live migrations chain does not match the manifest's
  sealed schema witness (`destination-drift`, migrations);
- the destination's live five-field identity witness does not match the
  manifest's recorded destination identity (`destination-drift`, identity) --
  this is what catches a same-data verification run pointed at the wrong
  database, such as a misconfigured connection string or a restored clone.
  The caller's expected identity must agree with the manifest as well. The
  copy records the destination's PostgreSQL system identifier in the
  manifest's destination witness, and the live identifier must equal that
  recorded value (and the caller's expected value), so a failover to a
  different physical cluster is refused even when the caller re-reads its
  expectation from the new cluster. A manifest written before the copy
  recorded the system identifier is refused with `destination-drift`; copy
  again to produce a manifest that binds the cluster. Resuming an interrupted
  verification also refuses a persisted report whose destination identity or
  system identifier differs from the manifest's, including a manifest that
  never recorded a system identifier;
- the destination's search configuration is absent, malformed, or present
  but does not match the digest this build's schema installer expects
  (a stable configuration installed from a different revision, for
  example) -- checked once before the fenced window opens, and again
  from inside the window to catch a value that changes mid-pass;
- the destination's transfer schema (ownership, grants and columns) no
  longer matches what this build expects when verification re-checks it
  inside the pinned read-only snapshot, for example because the schema
  changed after the check made before the window opened;
- the verification lease is already held by another worker
  (`lease-unavailable`).
- a lease check finds that the verification lease was lost, which is either
  expired or taken over (`lease-lost`); see "Lease checks" below.

A refusal writes nothing. It is not the same outcome as a persisted report
with mismatches: a refusal means verification could not even take a coherent
reading of the destination, while a report with mismatches means it could,
and the reading disagreed with the source.

### Reconciliation classes recorded in a mismatch

Every mismatch names a domain, a closed class (`count`, `digest`, `identity`,
`relation`, `sequence`, `schema`, `ledger`, `sample`) and an opaque identity
digest -- never the differing values themselves, a diff, or a query string.
Three classes are worth calling out because they exist specifically to catch
failures that byte-for-byte content equality cannot see:

- **`sequence`**: every PostgreSQL identity column backing a copied domain
  (conversations, messages, recall surfacings, session instructions, passive
  events) must have its sequence's `last_value` at or above the maximum
  identity value actually present in that domain's copied rows. A sequence
  that was reset or never advanced collides with the very next insert after
  activation, even though every canonical digest for that domain is
  identical to a correctly migrated destination -- this is why the check
  exists as its own class rather than folding into the census.
- **`ledger`**: for each domain, the transfer batches recorded for the run
  must form one contiguous chain that starts at the copy's initial
  checkpoint and ordinal 0 and ends at the manifest's checkpoint and
  ordinal. A missing link, a leftover or duplicate batch, or a second
  chain is a ledger mismatch. An empty batch is accepted only as the last
  batch of its domain.
- **`sample`**: the step-5 public reads run two probes through the real
  production read paths, never a hand-written re-implementation of either.
  The ordered-listing probe runs `PostgreSqlConversationRepository`'s
  production read and compares the result against the source's own
  canonical `(createdAt, identitySha256, title)` entries captured while
  streaming the source. Entries are grouped by `createdAt` truncated to the
  millisecond, and each group's `[identity, title]` pairs are compared as a
  sorted multiset rather than positionally: the destination lists
  same-millisecond ties by its own native row id, an independent key from
  the source's tie-break, so a positional comparison would flag a correctly
  copied project whenever those two tie-breaks happened to disagree. Each
  destination row's identity is the conversation's portable identity,
  derived by the same function the portable record uses from the
  conversation's own columns, read with the same microsecond text
  projection the portable export uses (a JavaScript date would drop the
  sub-millisecond digits the identity is computed from). Identical
  conversation headers are numbered `0` to `n-1`, which matches the source's
  occurrence ordinals as a set. No transfer-ledger table is read. A
  repository bug in filtering, ordering, row count or titles, a
  substituted record, or two conversations that traded titles inside one
  millisecond all change a group's pairs and show up here. The search self-match
  probe runs `PostgreSqlLexicalSearchRepository.searchMessages` against
  `lcm.search_v1`, walking a small, seeded pool of source message
  candidates until one candidate's own content produces a non-empty
  destination search result -- a message finding itself, never a
  cross-engine comparison against the source's own search behaviour,
  since SQLite and PostgreSQL tokenize differently and reproducing
  PostgreSQL's tokenization in this driver would be exactly the kind of
  second implementation this item has rejected elsewhere. If every
  candidate in the pool exhausts without a match, the probe cannot tell
  "search is broken" apart from "the sampled candidates happen not to
  index to anything" and does not guess: it marks itself not-run with its
  reason, and `activationEligible` cannot be true for that pass even
  though nothing is recorded as a mismatch. On a real project with real
  message content this does not trigger; it exists to catch a
  `search_v1` configuration that is wrong in a way no digest comparison
  can see.

  The search self-match candidate pool draws from a fixed-size, early
  slice of the source's canonical message order (the first
  `MIGRATION_SEARCH_PROBE_CANDIDATE_POOL_SIZE` messages), not the whole
  domain: reading an arbitrary position deep in the domain would require
  either a second full domain read or buffering the domain in memory,
  both of which this item has avoided elsewhere for the same cost
  reason. The seed drawn from `sampleParameters.seedBasisSha256`
  chooses the starting index and wrap order within that fixed pool, so
  the walk is still deterministic and reproducible from the recorded
  candidate ordinal, but the probe only ever samples an early canonical
  region of the domain rather than the whole domain. This is a real
  limitation of what the probe's pass proves -- content anomalies
  confined to messages outside the pool are not covered by this
  particular probe -- even though it is the right trade for a liveness
  check whose job is to catch `search_v1` configuration drift rather
  than to sample the domain exhaustively.

  The ordered-listing probe's own `ran` state (it completed) and the search
  probe's own `ran` state (a correlated self-match was confirmed) are tracked
  independently (`publicProbeCoverage`, one
  entry per probe), never folded into a single `sample`-class coverage
  bit: a genuine listing-ordering mismatch stays recorded as evidence
  exactly when the listing probe ran, regardless of whether the search
  probe could evaluate that pass, and a not-run search probe refuses
  `activationEligible` on its own regardless of what the listing probe
  found. Collapsing both probes' liveness into one bit meant a listing
  mismatch found in the same pass as a not-run search probe had no
  honest way to be recorded -- the report would either have to discard
  real evidence of a listing-ordering bug, or claim `sample` fully ran
  when only half of it did.

### The public-probe sampling skew

The ordered-listing probe always runs before the fenced census window opens,
never inside it or after it: PostgreSQL's read surface has no read-only
transaction mode, so a repository read (which is read-write by construction)
cannot run inside the window at all. This means the probe describes an
instant **at or before** the census, never after it. A write committed
between the probe and the census can only make the probe look stale in the
conservative direction -- optimistic, not pessimistic -- because the census
itself is the authoritative, final read and is what publication actually
gates on. The report binds a versioned ordering marker together with the
probe's own digest specifically so this ordering fact travels with the
report rather than depending on prose alone.

### Mismatch evidence is truncated per (domain, class) pair, never the exact count

A single mismatch class is capped at 100 retained entries in the persisted
report, allocated fairly across every domain that class spans rather than
consumed entirely by whichever domain sorts first: every domain with at
least one mismatch in a class keeps at least one retained entry, and the
remaining budget is distributed round-robin across those domains in frozen
order. This exists so a badly diverged destination -- the case where
operator evidence matters most -- still produces a persisted report instead
of an in-process failure with no evidence at all, even when the failure
spans more than one domain in the same class. Truncating per class alone,
ignoring domain, could retain the full 100-entry budget from a single early
domain and drop every entry from a later domain in the same class, while
that later domain's **exact** total is still recorded separately -- and the
report's own consistency check refuses to persist a total with zero
retained entries, so a multi-domain failure produced neither a refused
report nor evidence under that scheme. The exact total for each
(domain, class) pair is always recorded separately from the retained
entries and is never itself truncated; an operator reading a report with a
truncated class sees both the retained example entries (at least one per
affected domain) and the true total for every domain that class spans.

### Verification cost scales with the rows in scope

The in-window read -- the fenced census (which also collects `relation`-
class dependency edges via a second `readDomainPage` walk over the same
open destination source), the sequence self-consistency check, and the
`ledger` class's three-table SQL against `transfer_runs`/`transfer_batches`/
`transfer_identities` (including, as of round-4 P2, a per-domain identity-
set digest reconciling exactly which identities the ledger recorded
against what the destination's own read independently observed, and a
matching digest over each identity's record digest) -- does
not have a fixed cost. Its dominant cost is the census: the destination's
canonicalisation path reads and re-hashes each row individually rather
than in batches, and the `relation` class re-reads every row a second
time through that same per-record path to collect dependency edges, so
wall time is roughly linear in the number of rows in scope, not a flat
per-domain overhead.

The figure to size for is the whole in-window read (the read-only guard, the
census with its relation pass, the sequence check and the ledger check), not
the census alone. The census and relation passes dominate it because they read
each row; the guard, sequence and ledger checks are server-side
queries rather than per-row reads. The two probes that run before the
fenced window opens (the public-listing repository read and the
destination probe) are measured separately.

The extra `relation`-class read pass is structural, not an oversight left
for a later item. The only surface this driver is permitted to read
per-domain dependency data from is `readDomainPage`, an existing read
already approved for this driver, and that method necessarily re-reads
each record through the same `checkedRecordAt`/`recordAt`/`readCanonicalRow`
path the census itself uses during construction. There is no cheaper
approved surface: the census aggregate accessor exposes only
`{recordCount, prefixSha256, terminalIdentitySha256}` per domain, never
per-record dependency data, and widening it would mean touching
`portable-source.ts` beyond its two approved additive changes, which is
outside this item's scope. Construction of the destination source already
performs two full per-record reads before this driver's own code runs at
all -- once to build the canonical index, once more to compute the
terminal content digest -- so `relation`'s own contribution is one
additional pass over data already read twice, not the sole source of read
cost.

This matters because the census, the sequence check, the `relation` and
`ledger` reads, and the read-only guard all run inside one fenced window
held by a single verification lease, and the lease has a caller-supplied
`leaseTtlMs`. Verification does not renew a lease that is about to expire
mid-window; if the window does not finish inside the lease term,
verification fails rather than extending it, exactly like the rest of this
journal's refuse-and-restart pattern rather than a retry loop. An operator
sizing `leaseTtlMs` for a large project should measure the in-window read
against a realistic copy of that project's own row counts before a
cutover, not discover the lease was too short during one.

#### Lease checks

Verification checks that it still holds its lease twice: once right after
the read-only census window closes, and once right before it writes the
report (the preview, `inspectMigrationVerification`, makes only the first
check, because it writes nothing). When either check finds the lease lost,
verification refuses with `lease-lost` and writes no report. It releases
the lease and closes its connections either way, and a failure while doing
so never replaces the `lease-lost` refusal.

These checks refuse a report that is known to be stale; they do not extend
the lease and they do not guarantee it stays held. Verification never renews
the lease, so the lease can still expire after the second check, during the
local report write or while the manifest effect is begun and completed. Those
steps run without a new lease guarantee. Size `leaseTtlMs` as described
below so the window finishes well inside the term.

#### Measuring the in-window cost

Run the opt-in measurement from a checkout of this repository:

```bash
pnpm run test:postgresql:census-cost
```

The script builds the project and then runs only
`test/postgresql/migration-verification-census-cost.integration.ts` through
the PostgreSQL harness, against the harness's isolated PostgreSQL instance.
The measurement is excluded from `pnpm run test:postgresql` and from CI, so
it never runs unless you ask for it. It seeds a bulk fixture, runs the same
in-window reads verification runs, and prints a Markdown report with the row
count per domain, the wall time of each phase (marked as before or inside the
lease window), a `window total` row for the in-window read, a `measured total`
row that adds the two pre-window probes, and a `Proposed lease TTL` line. Set
`LCM_MIGRATION_CENSUS_COST_EVIDENCE_DIR` to a directory to have the report
written there as `census-cost.md` instead of printed.

Timings depend on the host and PostgreSQL instance, so measure on hardware
comparable to the cutover environment and repeat the measurement when that
environment changes. The cost is round-trip dominated and linear in rows, so
for a destination larger than the fixture, scale the measured in-window total
by the ratio of row counts before applying the margin below.

#### Sizing `leaseTtlMs`

Set `leaseTtlMs` to at least the measured in-window total multiplied by 3.
If the destination has more rows than the fixture, first scale that total by
the ratio of row counts, then multiply by 3. The 3x factor is a safety margin
for disk and network degradation; it is an assumption, not a second
measurement. The lease covers the ordered listing probe, the search probe, the
in-window reads and report persistence, which the margin is expected to
absorb. The destination probe runs before the lease is acquired. The report's
`Proposed lease TTL` line applies the same 3x factor to the measured total at
the fixture's own scale, including both pre-window probes, so it is never
smaller than this rule at that scale. Scale it by the row-count ratio too for
a larger destination.

### Verification memory use scales with the project

Verification holds its working evidence in memory for the whole run. There
is no streaming fallback: the run needs every set below at once, so memory
use grows with the size of the project and is not capped by a setting.

- **Destination.** For every domain, the set of record identities and the set
  of dependency edges read from the destination, plus one record digest per
  record. Identities and record digests are 64-character hex digests; an edge
  key combines the child identity, the parent domain and the parent identity,
  so it is a little over twice that length.
- **Source.** For every domain, the set of dependency edges, plus one entry
  per conversation (creation time, identity digest and title) used for the
  public-listing comparison, plus a small fixed pool of message candidates
  for the search probe.
- **Public listing.** The complete result of the destination's conversation
  listing, which the probe reads in one call, one header row per destination
  conversation read to derive its identity, and the entries derived from them.

Both sides are held concurrently, so peak memory is roughly proportional to
the number of records plus dependency edges on the source and on the
destination together, plus the number of conversations on both sides.
Conversation titles are held in full.

The source side is read before the verification lease is acquired. The
public-listing read and the destination sets are built after the lease is
held, so a project large enough to need a long lease also needs the memory
for its destination sets during that lease. Size `leaseTtlMs` as described
above, and treat memory as a separate requirement: a longer lease does not
reduce it.

For a very large project, make sure the host has free memory for the record,
edge and conversation counts on both sides, and that the Node.js heap limit
of the process that runs verification is raised accordingly (for example with
`NODE_OPTIONS=--max-old-space-size=<megabytes>`). If the process runs out of
memory, verification stops and no report is written; it never trims its
evidence to fit. Verification restarts from the beginning, and a lease left
behind by the stopped process expires after `leaseTtlMs`.

## Migration activation

Activation is the cutover itself: it switches the daemon's storage selection
from the verified SQLite generation to its PostgreSQL destination. It runs on
one verified, activation-eligible generation while backend publication is
held for migration maintenance, and it is the only step in this journal that
changes what the daemon will read and write after its next restart.

### What activation checks before it changes anything

Every precondition is re-read live at the start of the run, never trusted
from an earlier pass:

- the manifest is `verified` (or `activating` from an interrupted earlier
  run) and its verification report is the one the manifest names, parses,
  and is activation-eligible;
- a maintenance journal is held for this generation, every writer on the
  roster is quiescent, and the fenced lease for the project is free or
  already this generation's. The window must have been entered from SQLite:
  a window a rollback entered from PostgreSQL is not an activation window and
  is refused as `maintenance-not-held`;
- the stored data on this machine belongs to exactly one project, the one
  being migrated. Activation of a machine with data for several projects
  refuses with `uncovered-projects`; multi-project cutover is out of scope
  here (see [Cutover sets](migration-cutover-set.md) for the contract that
  later releases build on);
- the destination identity, the project-map binding, the transfer-ledger copy
  binding and the destination census all match the verification report, and
  the PostgreSQL target passes the authenticated health check for the
  transfer role (see [The activation role](#the-activation-role)).

A failed precondition is a **refusal**. A refusal begins no effect and leaves
nothing to recover: fix the named condition and run again. Refusals name the
step (`S0` through `S8`) and a closed reason such as `maintenance-not-held`,
`lease-conflict`, `census-drift`, `project-map-drift` or `target-unhealthy`.
Unresolvable readings (an unreadable journal, an ambiguous lease) are refusals
too, distinct from a definite "no". A PostgreSQL failure while the census
reads the destination (a lost connection, a refused privilege, a schema
mismatch on the transfer session) is attributed exactly as the health check
attributes it, `target-unhealthy` or `target-unresolvable` at `S7`.

The destination identity query that compares the live destination with the
sealed manifest (at `S0`, `S5` and `S7`) is attributed the same way. A
definite server refusal (authentication, missing privilege) is reported as
`target-unhealthy`; a connection or transport failure is reported as
`target-unresolvable`. Both are refusals at the step that ran the query, or,
when an effect has already begun and the run is re-entered, an interruption of
the step in flight. Neither rejects the whole activation. A cancelled
activation is still rejected, not classified.

### The activation role

Activation connects to PostgreSQL as the **transfer role**: the role that
holds the reviewed runtime grants plus the
[transfer grant script](../src/storage/postgresql/reference/postgresql-transfer-grants.sql),
the same role the copy and the verification used. Every activation step runs
under it, including the lease, the health checks and the census; the health
check admits the role through the transfer readiness check, not the daemon's
runtime readiness check. There is no second connection as the daemon's
runtime role: PostgreSQL readiness admits exactly one grantee per database,
and the runtime and transfer privilege profiles are exclusive on one role, so
a database cannot admit both profiles at once. Callers therefore supply the
transfer role's connection settings for both of activation's settings
fields. A caller that supplies runtime-only settings is refused at `S6` with
`target-unhealthy` before any effect begins.

### After activation: the grant swap and the daemon

A successful activation proves that the transfer role could publish the
selection; it does **not** prove that the daemon can start. The daemon
enforces its exact runtime privilege profile when it starts, and that profile
rejects the transfer grants. Before starting the daemon on the new backend:

1. apply the reviewed runtime grant scripts to the daemon's runtime role (see
   [Provisioning a PostgreSQL database](configuration.md#provisioning-a-postgresql-database));
2. revoke the transfer grants from the transfer role (or drop that role) so
   the runtime role is the schema's only non-owner grantee;
3. start (or restart) the daemon, which performs its own readiness check
   against the runtime role and refuses to serve until it passes.

Also switch `LCM_POSTGRES_URL` from the transfer role's URL used for
activation to the runtime role's URL before starting the daemon or running a
rollback, and leave `migrationRole` naming the schema owner.

Leaving the transfer grants in place makes the daemon's readiness refuse the
database as `acl-shape` or `schema-fingerprint`; applying the runtime grants
before revoking the transfer grants is harmless, because readiness is only
evaluated when the daemon starts. A later improvement, #1607, teaches
readiness to admit the canonical transfer role next to the runtime role so
that activation can prove the daemon's own pair; until then the swap is the
operator's step.

### What activation writes, in order

Once the checks pass, activation records durable evidence before it touches
the live selection, in a fixed order so that any crash leaves a state the next
run can classify:

1. `prepare-activation` on the manifest (`verified` becomes `activating`);
2. `publish-activation` begins;
3. the sealed publication artifact, then the generation -> publication link,
   then the activation epoch, attempt and witness, then the witness binding;
4. the maintenance selection, then the selection binding;
5. the backend publication itself (project map and configuration), under the
   fenced lease;
6. the activation report, then `publish-activation` completes and the manifest
   is `active`.

The activation report is a pure function of durable state and lives at
`<home>/.lcm/migration-activation-reports/<sha256(generationId)>/<reportSha256>`.
It never contains the restart verdict; that is returned on the outcome.

### Interruptions and recovery

A failure after step 1 is an **interruption**, not a refusal: an effect has
begun. The outcome names the step (`S9` through `S16`), a closed cause, and
three facts an operator can act on: whether an effect began, whether the
publication is known to have been applied (`yes`, `no` or `unknown`), and
whether an activation report is known to be stored. `unknown` is reported
honestly when the journal or report store cannot be read; it is never
collapsed into a guess.

Recovery is to run activation again. The run resumes from the durable
evidence it finds (the manifest, the link and artifact, the stored attempt,
the journals, the stored report) and rolls forward; it never re-derives an
attempt that a selection already carries, and it reuses an artifact or a
report byte-identically when the bytes still authenticate. A resumed run
re-checks the same preconditions a fresh run does; one that fails on a
resumed run is reported as an interruption of the step that was in flight
(`S9`, `S10` or `S11`), with the failed check named in the detail, because
an effect has already begun. Nothing is
reversed automatically. If the published target turns out unhealthy after
publication, the outcome is `post-publication-unhealthy` with the restart
verdict; the selection stands, and the next run completes once the target is
healthy again. Reversal is a separate, explicit rollback.

### The lease and the unavailable window

Activation holds the project's fenced publication lease from the first check
until publication completes, renewing it after the census and before the
selection and the publication. The lease time to live is 15 minutes; a
stretch that outlives it is not silently continued. An expired lease is taken
over on the next run, which mints a new attempt if no selection exists yet
and otherwise continues the recorded one, reporting the advanced fencing
token on the outcome. A run that ends before any effect began (a refusal, or
a failure before `prepare-activation` was written, as an authenticated
manifest readback proves) releases the lease again on a best-effort basis,
so another generation of the same project can activate; a refusal or
interruption whose release failed says so in its detail. A cleanup failure
or a cancelled run can still leave the row behind, and a write whose result
is uncertain keeps it; the same generation recovers by taking the row over
on its next run. Once an effect has begun the lease is kept for the next run
to continue.

### The daemon restart

Publication changes the selection the daemon reads at startup. A daemon that
was running before activation keeps its old backend until it restarts, so the
outcome carries a restart verdict: satisfied when no daemon is running or the
live daemon already reports the new backend, unsatisfied when a live daemon
still reports the old one, and unresolvable when the pid file is malformed,
unreadable, a daemon answers on the port without a pid file, or the check
could not observe the daemon at all (for example, the stored config naming
the daemon port cannot be read). The port comes from the stored config
alone; the activation never needs the daemon's PostgreSQL secrets. Restart
the daemon before relying on the new backend.

### Preview

`previewMigrationActivation` reads the manifest, the verification report, the
journals, the link, the artifact and the restart verdict and reports each as
ok, refuse or unresolvable. It takes no lock, opens no PostgreSQL connection
and writes nothing, so it cannot evaluate quiescence, coverage, the
single-project rule, the lease, target health or the census, and it does not
predict the outcome of a run; those checks happen only inside the run itself.

