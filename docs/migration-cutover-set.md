# Cutover sets: moving every project of a machine at once

A **cutover set** is the contract for migrating a machine that stores data for
more than one project. One maintenance hold covers the whole set, and every
project in it is captured under that hold. This page defines the set, the
refusals that keep it all-or-nothing, and how a capture is bound to it.

> **Status.** This page describes the contract only. No `lcm migration`
> command enters a set hold yet: the operator commands to prepare, activate and
> roll back a set arrive with later children of the multi-project cutover
> epic (#1544). Until then, activation and rollback keep their single-project
> refusals (`uncovered-projects`, `multiple-remote-projects`), and a machine
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

## Releasing a set hold

A set hold whose members were only captured is released with
`lcm migration abort --confirm-generation <set id>`, with or without
`--generation <set id>`. The journal records the abort and keeps the source
backend selected. Settling per-member manifests and partial copies is part of
the later set commands.
