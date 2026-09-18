# Reversible migration and cutover journal

LCM has a checksum-sealed protocol for future SQLite-to-PostgreSQL migration
and cutover workflows. It records what a migration generation intends to do,
which external effect is pending, and which immutable evidence was accepted at
each step. A private durable journal makes an interrupted protocol run
recoverable without guessing from timestamps or partially changed data.

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

A **clean** report -- one with no recorded mismatches -- is the only report
that ever begins a `verify-generation` effect. A report **with** mismatches is
still persisted in full as operator evidence, but no effect is begun for it,
and it does not become activation-eligible. Recovering from a report with
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
  database, such as a misconfigured connection string or a restored clone;
- the destination's search configuration is absent or malformed;
- the verification lease is already held by another worker
  (`lease-unavailable`).

A refusal writes nothing. It is not the same outcome as a persisted report
with mismatches: a refusal means verification could not even take a coherent
reading of the destination, while a report with mismatches means it could,
and the reading disagreed with the source.

### Reconciliation classes recorded in a mismatch

Every mismatch names a domain, a closed class (`count`, `digest`, `identity`,
`relation`, `sequence`, `schema`, `ledger`, `sample`) and an opaque identity
digest -- never the differing values themselves, a diff, or a query string.
Two classes are worth calling out because they exist specifically to catch
failures that byte-for-byte content equality cannot see:

- **`sequence`**: every PostgreSQL identity column backing a copied domain
  (conversations, messages, recall surfacings, session instructions, passive
  events) must have its sequence's `last_value` at or above the maximum
  identity value actually present in that domain's copied rows. A sequence
  that was reset or never advanced collides with the very next insert after
  activation, even though every canonical digest for that domain is
  identical to a correctly migrated destination -- this is why the check
  exists as its own class rather than folding into the census.
- **`sample`**: the step-5 public-read probe runs the ordered-listing query
  through the real `PostgreSqlConversationRepository` production read path,
  not a hand-written re-implementation of it, and compares the result
  against the source's own canonical `createdAt` ordering captured while
  streaming the source. A repository bug in filtering, ordering, or row
  count shows up here even when the underlying copied bytes are correct.

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

### Mismatch evidence is truncated per class, never the exact count

A single mismatch class is capped at 100 retained entries in the persisted
report, regardless of how many domains it spans. This exists so a badly
diverged destination -- the case where operator evidence matters most --
still produces a persisted report instead of an in-process failure with no
evidence at all. The **exact** total for each (domain, class) pair is always
recorded separately from the retained entries and is never itself truncated;
an operator reading a report with a truncated class sees both the 100 (or
fewer) example entries and the true total.
