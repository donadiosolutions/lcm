# Cutover sets: moving every project of a machine at once

A **cutover set** is the contract for migrating a machine that stores data for
more than one project. One maintenance hold covers the whole set, and every
project in it is captured under that hold. This page defines the set, the
refusals that keep it all-or-nothing, and how a capture is bound to it.

> **Status.** This page describes the contract and the preparation,
> activation and rollback services behind it. No `lcm migration` command
> enters, prepares, activates or rolls back a set yet: the operator commands
> arrive with a later child of the multi-project cutover epic (#1544). Until
> then, the single-generation activation and rollback commands keep their
> single-project refusals (`uncovered-projects`,
> `multiple-remote-projects`), a member of a held set cannot be activated
> through them, and a machine with data for one project behaves exactly as
> described in [Reversible migration and cutover journal](migration-cutover.md).

## What a set contains

A set is a version-1 manifest naming:

- the **set id** and the local **machine id**;
- one **member** for every project that has stored data under this home, sorted
  by project: the physical project id, the member's own generation id, and the
  hash of the member's authenticated source selection.

Membership is exactly the stored-data project set: the project directories
with a `db.sqlite` and the `events/<project>.db` files that exist. No time,
count or heuristic decides it. A set has at least two members; a home with
one stored-data project is not a set and uses the single-generation path.
The set id and every member generation id use the publication-id grammar, are
distinct from each other, and the machine id is a canonical UUID.

## When a set is refused

The whole set is refused, before any hold is entered, unless every stored-data
project can be authenticated as a local member of this machine.

| Reason | Meaning |
| --- | --- |
| `cutover-set-enumeration-unresolvable` | The stored-data enumeration could not be read; its own reason is attached. |
| `cutover-set-single-project` | Fewer than two projects have stored data. |
| `cutover-set-uncovered-member` | A stored-data project has no project-map entry, or its canonical path authenticates a different project (including an authority that names another project than the one it was supplied for). Every such project is listed. |
| `cutover-set-member-unverifiable` | A project's source metadata could not be read or authenticated. Every such project is listed. |
| `cutover-set-incomplete` | A stored-data project has no member generation. |
| `cutover-set-unknown-member` | A member names a project without stored data. |
| `cutover-set-member-not-local` | A member has a shared (multi-machine) project identity. |
| `cutover-set-machine-mismatch` | A member's authority belongs to a different machine. |
| `cutover-set-duplicate-generation` | Two members share a generation id, or a member reuses the set id. |
| `cutover-set-too-large` | The set journal could outgrow the 1 MiB journal read limit once every member is captured and the hold is aborted. |

No project is left out to make a set fit: an uncovered or unreadable project
refuses the whole set.

Two further refusals apply while a hold is live. A capture refuses with
`cutover-set-membership-drift` when the stored-data projects differ from the
set members (a project gained or lost data under the hold), and with
`cutover-set-member-unbound` when the requested generation is not a member or
its source authority differs from the one recorded at entry. A capture that
cannot enumerate the projects refuses with
`cutover-set-enumeration-unresolvable`.

## One hold for the whole set

The set is recorded in the machine's maintenance journal as one optional
`cutoverSet` field (manifest plus one binding per member). Single-generation
journals do not have the field, so their bytes and checksums are unchanged. An
older LCM that reads a set journal refuses it as malformed rather than
misreading it.

While the set is held:

- the journal's generation and publication id are the set id, and its
  source-selection hash is the digest of the manifest;
- its roster is one immutable row for this machine with no queue cutoff;
- its queue-evidence hash is derived from the member bindings and moves as
  members are captured; it is never an independent value.

A set selects its backend as one complete tuple (see
[Activating a set](#activating-a-set)): the journal enters the selection phases
only with the tuple that names every member's selected evidence, and the
single-generation writer quiescence check still reports
`cutover-set-unsupported` for a set hold. Replay admission refuses every
generation while a set hold is live or selected but not yet published, so a
member's earlier selection can never admit a replay under an unsettled set.

## Per-member queue-cutoff evidence

Each member is captured from its own snapshot and records its own queue cutoff
and source-byte evidence under the hold. At entry every member holds an unbound
placeholder; capturing a member replaces only that member's binding. The
binding checksum a capture presents covers the member's identity, its binding
and the immutable hold fields, and excludes other members and the update time,
so capturing one member does not invalidate another member's capture.
Nothing is copied or inferred from a different member.

## Preparing a set

Preparation takes one hold and then, member by member, captures, copies and
verifies every project under it. The service is the internal contract the set
commands (#1551) will expose; nothing here is reachable from the CLI yet.

1. **Preview.** The candidate names the set id and each member's generation
   id without writing anything. Each member's id comes from that member's own
   base (project, canonical path and the target's host, port and database)
   plus the first free ordinal, and the set id is derived from the target and
   those `(project, generation)` pairs. If a member's earlier generation
   becomes occupied (for example by an aborted attempt that captured it), its
   ordinal advances and the set id changes, so an old confirmation is refused
   with `confirmation-generation-moved` before anything is written.
   While a set is already entering or held, the preview returns its persisted
   set and member ids as they are, without recomputing them; preparing then
   refuses a different target (`cutover-set-target-changed`).
2. **Confirm, then hold.** The confirmed set id is compared first. Only then
   is each member's destination identity resolved (this can create the
   destination project and is reported per member), the sources are
   authenticated again, the set is rebuilt, every selected id is checked free
   once more, and the hold is entered with a single write. No member snapshot
   exists before that write, and the hold fences every writer for the whole
   home.
3. **Per member, in manifest order.** Each step rereads the journal and that
   member's own binding: capture (when its snapshot is absent), genesis and
   the dry-run effect, copy, and verification against the one resolved
   target. Another member's evidence is never used for it.

A preparation finishes only when every member's manifest is `verified`, no
effect is pending and its persisted verification report is eligible.

### Resuming

Calling the preparation again with the same set id continues from each
member's durable state, so a verified member is validated and skipped, not
copied again. A member that stopped

- before capture is captured; with a complete snapshot and no manifest it
  starts at genesis;
- inside genesis (a planned manifest, with or without its dry-run effect
  pending) completes the dry run with the effect id it carried;
- in the copy continues the copy; in a copied state it is verified;
- after verification began finishes that verification from its persisted
  report, without reopening the destination.

A resume refuses, before it touches any member, when the target changed
(`cutover-set-target-changed`: a held member id is not in the family its
project, path and the supplied target produce), when a member has no
persisted project-map entry, or when its destination project is missing. It
never mints under a live hold.

Once the hold is held (freshly entered, resumed, or recovered from an
entering state, never while it is still entering) and before any member is
touched, one append-barrier span enumerates and authenticates every
stored-data project again. The preparation refuses, with the hold and all
evidence preserved and no member started, when the enumeration cannot be
read (`cutover-set-enumeration-unresolvable`), a project cannot be
authenticated (`cutover-set-member-unverifiable`), the stored-data projects
are not exactly the held members (`cutover-set-membership-drift`, naming the
projects that differ), or a project's source selection is not the one the hold
bound (`cutover-set-authority-drifted`). Nothing is recaptured and no source
bytes are recomputed for this check; a verified member is still validated and
skipped afterwards.

### When a member is blocked

The first member that cannot proceed stops the preparation. The result names
that member and a reason, later members are not started, the hold stays, and
every member's durable evidence is preserved. Typical reasons are
`member-verification-failed` (the report is kept; the manifest stays
`copied`), `member-snapshot-partial`, `member-snapshot-tampered`,
`member-authority-drifted` (the member's source selection changed between the
held-authority check and its capture), `member-binding-drifted` (its sealed
snapshot no longer carries its current binding),
`cutover-set-membership-drift` (a capture found the stored-data projects
changed under the hold), `capture-contention`, `copy-failed` and
`member-state-unexpected`. Fix the cause and call the preparation again, or
release the hold as described below.

Refusals that precede the hold (a publication in the journal slot, a
single-generation hold, an unsettled earlier set, a builder refusal, a moved
confirmation) leave the set unheld; any identity writes made before a later
refusal are reported per member and are not undone.

## Activating a set

Activation takes a prepared set and binds every member to PostgreSQL in one
publication. The service is internal until #1551 exposes it; it is called with
the home, the confirmed set id and the one resolved target, whose migration
role is the activation role (the runtime grants are applied, and the migration
grants revoked, after activation, as for a single generation).

### Every member is revalidated first

Before any member's manifest moves, the whole set is checked under one
publication barrier, and the set is refused on the first failing condition of
the home or, for member conditions, with every failing member named:

- the set must be held (an entering set must finish its preparation; an aborted
  set is never revived, even if an earlier activation attempt left a
  checkpoint behind);
- the stored-data projects must still be exactly the held members with the
  source selections the hold bound (`cutover-set-membership-drift`,
  `cutover-set-authority-drifted`), and project-map coverage must hold;
- a set that was held before the selection tuple existed and could outgrow the
  journal read limit once selected is refused (`cutover-set-too-large`) and
  stays abortable;
- for each member: its persisted project-map path, its destination project, its
  generation family under the supplied target, its captured queue cutoff, its
  sealed snapshot, a verified and eligible manifest with its matching report,
  its generation link, the project-map witness, the copy binding read back
  from the destination transfer ledger, the live destination identity, one
  activation lease per destination project under the set id, writer
  quiescence attributed to that member's own binding, target health, and a
  fresh read-only census of its destination project compared with its report.

A member whose evidence is missing, no longer eligible or disagrees with its
report is `stale`; one whose source, map, identity or binding changed is
`drifted`; one whose state cannot be read or fenced is `unverifiable`; a
member with no manifest or no capture is `absent`. The refusal reason is the
selection rule's (`cutover-set-member-evidence-stale`,
`cutover-set-member-evidence-drifted`,
`cutover-set-member-evidence-unverifiable`,
`cutover-set-member-evidence-absent`), with each member's own reason beside it.
A refusal begins no member effect, leaves the hold and every member's
evidence intact, and releases the leases it acquired; the composed activation
artifact may already be persisted (it is reused byte-identically by the next
call) and the coverage check may have reconciled the project map. No member's
evidence is ever inferred from another's, and no time, count or heuristic
decides eligibility.

### One checkpoint, member effects, one selection, one publication

Once every member passes, the publication material is composed once for all
members and sealed as one activation artifact, and an immutable **activation
checkpoint** records the set manifest, the held journal checksum, the shared
publication id (the set id), the artifact identity and, per member, its
destination project, held binding digest, copy binding, frozen verified
manifest revision and verification report. After the checkpoint nothing is
recomposed: a resume reads the checkpoint and the artifact it names.

Each member then receives its own activation effects in manifest order
(prepare-activation, publish-activation, its generation link to the shared
artifact, its epoch, attempt, witness and witness binding), never derived from
a sibling. With every member pending, the **selection tuple** is frozen: the
complete list of every member's selected epoch, attempt and witness, bound to
the checkpoint by digest. The journal then enters `selection-prepared` and
`selection-completed` carrying that tuple; its terminal evidence is the
tuple's checksum, and a held member binding digest, a single witness or a
rehashed tuple is never accepted in its place. Each member's selection
binding is written as an index onto the tuple, and the existing publication
driver runs exactly once with every project, acquiring and releasing the
members' fences itself.

Between `selection-completed` and the completed publication the home is in a
fenced handoff: the configuration and project map are still the old ones,
ordinary consumers that derive the backend from the configuration refuse the
unresolved publication, and no member replays. The effective home is therefore
always complete-old, complete-new or explicitly unresolved, never one project
on each backend. A running daemon keeps its prior backend until it restarts,
as for a single generation.

### After the publication

Target health is observed once. An unhealthy target returns
`post-publication-unhealthy` before any member report is stored: the selected
backend and every member's evidence stay, and the next call settles the
members. Otherwise each member's post-publication project-map witness is
compared with its verified witness, its deterministic activation report is
stored and its publish-activation effect completes. A witness mismatch, a
report conflict or an uncertain write stops with an interruption that keeps
the completed publication and the selection; `publication-failed` names only
a publication the driver confirmed aborted, after which every member's replay
stays unresolved despite its selection index (the only automatic re-prepare is
the driver's pre-seal aborted shape). Any other driver outcome (an unsatisfied
or unresolvable fence, a colliding journal, missing or unreadable artifact
material, a publication that cannot be attributed) is an interruption that
keeps the selection, the member evidence and the journal for the next call.

### Crash recovery

Calling the activation again with the same set id resumes from durable state
and never admits a mixed selection:

| Interrupted at | Resume |
| --- | --- |
| Any check, lease or the artifact before the checkpoint | nothing moved; the orphan artifact is reused byte-identically |
| After the checkpoint, before or between member effects | every member is revalidated; begun effects and their leases are kept, missing steps finish |
| After the frozen tuple, before or at the selection phases | the frozen attempts are adopted, never re-minted; the same tuple is prepared and completed |
| `selection-completed`, before or during the publication | member indexes are repaired from the tuple and the one publication is driven on |
| After the completed publication | members settle from their own evidence; an already active member authenticates its report and is skipped |
| The set journal gone before the first publication write (empty slot) | with every member pending and its activation report directory positively absent, the frozen artifact is prepared fresh; with every member active the activation is reported from their reports; anything mixed, any report present or a report directory that cannot be authenticated is interrupted and nothing is republished |
| The slot occupied by another hold or publication | with every member active the activation is reported from their reports; otherwise it is interrupted and nothing is prepared over the occupant |

A lease that expires before the tuple is frozen is taken over and that
member's attempt re-minted; after the freeze a takeover keeps the frozen
attempts and reports that member's successor token on its own member row. A
lost lease or an unreadable state is an interruption that preserves evidence,
never a fresh refusal claiming nothing happened. Leases are released by a
refusal and by an interruption whose members are all positively unbegun (no
member manifest moved); once any member effect exists the leases are retained
for the roll-forward.

### Replay after a set activation

A member's replay evidence is admitted only through the set's records: the
member's selection index must restate its row of the frozen tuple, and then
either the set's completed publication must cover exactly the artifact's
projects, or, once a later publication has replaced that journal, the member's
own active manifest and its activation report must name this set's
publication, artifact and witness. A bare index, a report-only member and an
aborted set publication refuse.

A rollback commitment is the one exception to both the report-derived
activation success above and this admission: once a set rollback has written
its checkpoint (see below), the activation records of that set, the member's
active manifest and its activation report no longer admit anything, whether
or not the activation publication is still in the live slot, and
`activateCutoverSet` refuses the set (`cutover-set-rollback-committed`)
instead of adopting, re-driving or reporting it. Replay then follows the
rollback rules in [Replay across a set rollback](#replay-across-a-set-rollback).

## Rolling a set back

Rolling an activated set back restores every member to a **new** SQLite
generation under one PostgreSQL-origin hold and publishes the complete home
back to SQLite once. The rollback service (`rollbackCutoverSet`) takes the
original activated set id; no `lcm migration` command reaches it until the
operator commands of #1551, and no release metadata changes here. The
single-generation rollback keeps its own behavior (including its no-copy
pre-write reversal) and its refusal of a member of a held set.

### What is admitted

| Durable state | Route |
| --- | --- |
| The set's completed activation publication (target PostgreSQL) is live, every member is active, or activating with the set's pending publish-activation | eligible: the pending activation bookkeeping is settled first, then the rollback commits |
| The activation is held, prepared, frozen but not published, or its publication is not completed | refused (`activation-not-completed`); resume or abort the activation first |
| The slot is empty or holds another publication or hold, and no rollback record exists | refused (`activation-not-live` / `maintenance-held-by-other`) |
| A member is not an authenticated active member (manifest, link, frozen epoch/attempt/witness, preserved snapshot, project map binding) | refused before anything moves, naming the member |
| PostgreSQL is unreachable, or a member's live destination identity differs from its activation epoch | refused (`target-unreachable` / `target-identity-drift`) |

A completed, authenticated activation whose later target health check failed
(`post-publication-unhealthy`) stays eligible: the record proves the
selection, not daemon health. The rollback still needs reachable PostgreSQL,
one fenced lease per member and a fresh identity, schema, delta and census
readback for every member; an unavailable destination blocks the whole set
and preserves everything. There is no offline restoration.

### Commitment, hold, one new generation per member

Under one retained append barrier the service revalidates every member,
settles any pending activation bookkeeping from the completed publication,
composes and seals the reverse publication material (every member unbound,
SQLite selected) and writes the **rollback checkpoint**, keyed by the
original set id: the rollback hold manifest (the original members under the
derived rollback set id), the activation records it unwinds, the reverse
artifact identity and, per member, its preserved snapshot, forward held
binding, activation epoch, attempt and witness, settled head and lease
evidence. From this record on the rollback is committed: every member's old
activation evidence is fenced for replay, and later failures are blocked
members or interruptions that keep the hold and the evidence.

The hold is then entered from PostgreSQL under the rollback set id, each
member's rollback cutoff is bound from its authenticated preserved snapshot
(the forward held binding is authenticated separately against the activation
checkpoint), one PostgreSQL runtime is opened and every member gets a fenced
session on the same lease tuple the reverse coordinator will adopt, with one
set-wide renewal keeper. Every member is classified independently from its own
readback (pre-write: nothing was written after activation; post-write:
something was) before any member effect; a refused member blocks the set.

Each member then moves through prepare-rollback and gets a fresh physical
SQLite candidate: a post-write member is exported from its fenced PostgreSQL
snapshot, a pre-write member is rebuilt from its preserved snapshot (its
source witness must be the member manifest's verified source). Every
candidate is independently verified, then every member is revalidated under a
new snapshot (unchanged mode; for post-write the export's delta and census
reproduced), its rollback witness recorded and bound and its publish-rollback
begun. Only then is each candidate installed at the member's canonical
database path (the original is preserved read-only beside the candidate and
named in the member's installation record), its sidecars materialized and its
installation record written. The thin selection tuple (one row per member:
mode, epoch, attempt, rollback witness and the installation record's digest)
is frozen, the one selection is prepared and completed, each member's rollback
binding is recorded under the shared rollback publication id, the sealed
reverse material is compared with the live source and prepared, and the one
publication is driven to completion. Each member's deterministic rollback
report is stored and its publish-rollback completed; the result is
`rolled-back` with every member's mode and installed generation.

A blocked member (lease conflict, refused quiescence, an ineligible or drifted
readback, a failed or quarantined build, a preserved source that is not the
verified one, a failed install, an installed database that no longer matches
its record, a cancelled call) blocks the whole set: the hold, the checkpoint,
every preserved source, every verified or quarantined candidate and every
record stay; calling again resumes. Leases are released only while no member
manifest moved. There is no set rollback abort in #1550: the forward set
abort refuses a PostgreSQL-origin hold (`journal-rollback-hold`), and so
does the set preparation (`cutover-set-rollback-held`).

### Crash recovery of a rollback

| Interrupted at | Resume |
| --- | --- |
| Before the checkpoint | nothing moved; an orphan reverse artifact is reused byte-identically; PostgreSQL stays selected and old replay evidence is admitted |
| After the checkpoint, before the hold | the activation publication is still live and PostgreSQL selected; old replay evidence is already fenced; the same hold is entered |
| Entering the hold | the exact entering journal is completed before the barrier, then the hold resumes |
| Held, between cutoffs, classification, prepare, build, revalidation or install | missing cutoffs are bound, every member is classified again, pending effects must reproduce their frozen input, candidates are rebuilt where no installation record exists (earlier candidates stay preserved, the first preempted original is never rewritten), recorded installations are authenticated and adopted |
| After the frozen tuple, before or at the selection phases | the tuple and every installation are adopted, never rebuilt; a prepared selection is completed only once every member's readback still reproduces its frozen witness |
| `selection-completed`, before or during the reverse publication | member bindings are repaired and the one publication is prepared (after proving the live source equals the sealed source) or resumed; a publication the coordinator left unsealed or aborted is settled and prepared again under recovery sessions |
| After the completed reverse publication | SQLite is selected; members settle from their own evidence; an already rolled-back member authenticates its report and installation |
| The rollback hold aborted, or gone before the selection was frozen | interrupted: nothing restarts automatically and nothing is deleted |
| A later hold or publication replaced the completed reverse journal | with every member rolled back the rollback is reported from member evidence and the selected SQLite installation; otherwise it is interrupted and nothing is republished |

After every row the effective home is complete-PostgreSQL, complete-SQLite or
explicitly unresolved (the reverse publication in flight), never one project
on each backend.

### Replay across a set rollback

A member's replay commitment is located from its own activation link to the
rollback records; no store is scanned. From the checkpoint until the reverse
publication completes every member refuses, whatever evidence it presents.
Afterwards only the member's rollback witness (its row of the frozen tuple)
is admitted, as SQLite: through the rollback's completed publication covering
exactly the reverse artifact's projects, or, once a later publication or hold
replaced that journal, through every member being rolled back with the
rollback report of its frozen witness while the selected installation is
SQLite with every member unbound. The old activation witness, a bare index
whose commitment vanished, an aborted or in-flight reverse publication, a
rolled-back set under a PostgreSQL configuration and a rebound member all
refuse. Original member manifests settle to rolled-back and keep their
history; they never become replay authority for the replacement database.


## Releasing a set hold

A set hold is released, before its selection, with
`lcm migration abort --confirm-generation <set id>`,
with or without `--generation <set id>`. The confirmation is always the set
id, never a member's generation id. The journal records the abort and keeps the
source backend selected, and the same invocation settles every member
manifest: all members are classified before the first write, a member with a
pending copy effect refuses the abort with that member's evidence, written as
`<member generation id>:<evidence>` and keeping the usual reason and the
`resume` next step (finish it with a preparation resume first), and the journal is terminalized only if it is
not already. Running the abort again after an interruption converges the
members it left unsettled, including a member whose abort effect was begun and
not completed. A set whose members already carry activation effects, or whose
journal has reached the selection phases, refuses the abort rather than
deleting activation evidence; resume the activation instead. The command reports success only after every member is absent
or aborted with nothing pending, and a new preparation or single-generation
apply is refused (`abort-or-resume-required`) while a member of an earlier set
is not settled.
