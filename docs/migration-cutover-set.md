# Cutover sets: moving every project of a machine at once

A **cutover set** is the contract for migrating a machine that stores data for
more than one project. One maintenance hold covers the whole set, and every
project in it is captured under that hold. This page defines the set, the
refusals that keep it all-or-nothing, and how a capture is bound to it.

> **Status.** This page describes the contract and the preparation service
> behind it. No `lcm migration` command enters or prepares a set yet: the
> operator commands to prepare, activate and roll back a set arrive with later
> children of the multi-project cutover epic (#1544). Until then, activation
> and rollback keep their single-project refusals
> (`uncovered-projects`, `multiple-remote-projects`), and a machine
> with data for one project behaves exactly as described in
> [Reversible migration and cutover journal](migration-cutover.md).

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

Selection of a backend is not defined for a set yet: a set journal cannot enter
the selection phases, and activation writer quiescence reports
`cutover-set-unsupported`. Replay admission refuses every generation while a
set hold is live, so a member's earlier selection can never admit a replay
under an unsettled set.

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

### When a member is blocked

The first member that cannot proceed stops the preparation. The result names
that member and a reason, later members are not started, the hold stays, and
every member's durable evidence is preserved. Typical reasons are
`member-verification-failed` (the report is kept; the manifest stays
`copied`), `member-snapshot-partial`, `member-snapshot-tampered`,
`cutover-set-membership-drift`, `capture-contention`, `copy-failed` and
`member-state-unexpected`. Fix the cause and call the preparation again, or
release the hold as described below.

Refusals that precede the hold (a publication in the journal slot, a
single-generation hold, an unsettled earlier set, a builder refusal, a moved
confirmation) leave the set unheld; any identity writes made before a later
refusal are reported per member and are not undone.

## Releasing a set hold

A set hold is released with `lcm migration abort --confirm-generation <set id>`,
with or without `--generation <set id>`. The confirmation is always the set
id, never a member's generation id. The journal records the abort and keeps the
source backend selected, and the same invocation settles every member
manifest: all members are classified before the first write, a member with a
pending copy effect refuses the abort with that member's evidence (finish it
with a preparation resume first), and the journal is terminalized only if it is
not already. Running the abort again after an interruption converges the
members it left unsettled, including a member whose abort effect was begun and
not completed. The command reports success only after every member is absent
or aborted with nothing pending, and a new preparation or single-generation
apply is refused (`abort-or-resume-required`) while a member of an earlier set
is not settled.
