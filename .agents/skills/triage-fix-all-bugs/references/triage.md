# Inventory and triage

Read the shared contract in [SKILL.md](../SKILL.md) before applying this phase.

**Contents:** Preflight → immutable S0 → existing parents → native Epic hierarchy → triage workers → duplicate adjudication → triage barrier.

## 0. Preflight

Before mutating any GitHub issue or launching any worker:

1. determine the repository's actual default branch;
2. determine its exact HEAD SHA;
3. verify that the repository or organization exposes a native GitHub issue type named exactly `Bug`;
4. verify that a native GitHub issue type named exactly `Epic` is available for the tracking hierarchy;
5. verify that native GitHub sub-issue relationships are available;
6. determine any native GitHub sub-issue capacity constraints that affect the tracking hierarchy;
7. verify that the root coordinator has enough access to:
   - enumerate native issue types;
   - create issues;
   - assign native issue types;
   - create native sub-issue relationships;
   - comment on issues;
   - close issues;
   - create and merge pull requests as required;
8. verify the main LCM daemon is running and healthy.

Do not silently replace missing native issue types or native issue relationships with labels, Projects fields, Markdown checklists, or other approximations.

If a required native GitHub capability is unavailable, stop before destructive mutation and report the blocker to the user.

Do not assume the default branch is named `master` or `main`.

## 1. Establish the immutable Bug set

At task start, perform an exhaustive enumeration of all open GitHub issues whose **native GitHub issue type** is exactly:

`Bug`

Call the resulting immutable set **S0**.

### Critical classification rule

`Bug` means the repository or organization's native GitHub issue type named exactly `Bug`.

It does **not** mean:

- an issue carrying a `bug` or `Bug` label;
- an issue whose title contains "bug";
- a GitHub Projects custom field;
- an issue that merely appears bug-like.

**Do not use labels as a substitute for GitHub issue type.**

If the convenient GitHub CLI command being used cannot reliably expose or filter native issue types, use another GitHub API or GraphQL query that can.

Do not silently fall back to label-based enumeration.

### Snapshot semantics

GitHub issue enumeration is not assumed to provide an atomic transactional snapshot.

Use these operational semantics:

1. record an enumeration-start timestamp **T0**;
2. enumerate all open issues using complete pagination;
3. select only issues whose native issue type is exactly `Bug`;
4. perform a second exhaustive enumeration before freezing S0;
5. compare the resulting Bug sets;
6. if they differ, repeat the exhaustive enumeration until two consecutive complete enumerations agree;
7. freeze the agreed result as S0;
8. record an S0-freeze timestamp **TF**.

Do not mutate candidate S0 issues before S0 is frozen.

S0 is the validated stable enumeration result established by this procedure. Do not attempt to reconstruct a historical atomic snapshot at T0 from issue timelines.

### Enumeration requirements

For every issue in S0, record:

- issue number;
- title;
- URL;
- native issue type;
- native parent issue, if any;
- enumeration-start timestamp T0;
- S0-freeze timestamp TF.

Also record:

- the repository's actual default branch;
- the exact default-branch HEAD SHA observed when S0 is frozen.

Sanity-check the resulting count and complete issue list before declaring S0 established.

Only after this validation may triage workers be launched.

Once established, **S0 never changes during this run**.

Issues created later, including Bugs created from deferred P2 findings, are not added to S0.

## 2. Existing ownership and parent relationships

During S0 establishment, inspect the native parent relationship of every Bug in S0.

If an S0 Bug already belongs to a native parent hierarchy outside this remediation run:

1. do not reparent it;
2. do not otherwise mutate it as part of this run;
3. record its existing parent;
4. classify it as:

`delegated-existing-parent`

5. treat that classification as a terminal S0 state;
6. include it in the tracking Epic inventory as externally owned.

A `delegated-existing-parent` Bug does not receive a triage worker and does not enter remediation.

It remains part of S0 for accounting and final completeness checks.

Do not alter another remediation hierarchy solely to make this run's tracking hierarchy complete.

## 3. Create the tracking Epic hierarchy

Create one new GitHub issue using the native GitHub issue type:

`Epic`

This is the **root remediation Epic**.

The root Epic must describe the remediation run and contain the complete S0 inventory, including Bugs classified as `delegated-existing-parent`.

The root Epic is the authoritative high-level progress tracker for this run.

### Native relationship requirements

For S0 Bugs that do not already belong to another native parent hierarchy, make them native descendants of the root remediation Epic.

Prefer direct native sub-issue relationships where capacity permits.

If the complete S0 set cannot fit directly beneath one Epic because of GitHub native hierarchy capacity:

1. create additional tracking issues using the native `Epic` issue type;
2. make those tracking Epics native descendants of the root remediation Epic;
3. distribute eligible S0 Bugs beneath those child Epics;
4. preserve one native remediation hierarchy rooted at the root Epic.

Tracking child Epics are orchestration metadata and are **not** members of S0.

Do not silently omit an S0 Bug because of native hierarchy capacity.

Do not substitute labels or a Markdown checklist for native issue relationships.

Bugs classified as `delegated-existing-parent` remain in their existing hierarchy and are represented in the root Epic inventory without being reparented.

### Epic state tracking

Keep the root Epic updated as S0 Bugs move through:

- delegated to existing parent;
- triage;
- closed during triage;
- queued for remediation;
- active remediation;
- PR open;
- merged/resolved;
- blocked or parked.

The root Epic should also track aggregate counters for this run.

## Phase 1: Triage

For every Bug in S0 that is not already in the terminal state `delegated-existing-parent`, spawn one independent:

**`TRIAGE_MODEL` with `TRIAGE_REASONING` and best-effort `TRIAGE_TIER`**

triage worker.

Launch triage workers in parallel where possible.

Each worker owns exactly one Bug for triage.

## Triage worker responsibilities

Each triage worker must independently determine:

1. whether the reported bug is still reproducible against the S0-freeze default-branch HEAD or a newer default-branch HEAD where appropriate;
2. whether the issue appears to duplicate another existing issue.

The worker must leave enough evidence on the issue for another engineer to understand and verify the conclusion.

### If no longer reproducible

Document:

- the attempted reproduction;
- environment or conditions used;
- relevant evidence;
- the conclusion.

Then close the Bug.

Record the triage disposition:

`closed-nonreproducible`

### If clearly duplicate of an issue outside S0

If the canonical issue is outside S0 and the duplicate relationship is unambiguous:

1. identify and link the canonical issue;
2. document the reasoning;
3. close the S0 Bug.

Record the triage disposition:

`closed-duplicate`

### If suspected duplicate of another S0 issue

If the suspected canonical or duplicate issue is also a member of S0:

1. document the suspected duplicate relationship;
2. provide evidence and reasoning;
3. do **not** close either S0 issue;
4. report the relationship to the root coordinator for centralized duplicate adjudication.

Independent S0 workers must not independently close each other as duplicates.

### If still reproducible

Record the reproduction result and supporting evidence.

Leave the Bug open for remediation.

Record the triage disposition:

`reproducible`

### If uncertain

Do not close the Bug merely because reproduction was inconclusive.

Document what was attempted and why the result remains uncertain.

Keep it open and treat it as needing remediation unless there is positive evidence that it is obsolete or duplicated.

Record the triage disposition:

`uncertain-needs-remediation`

## Triage worker completion event

When a triage worker reaches a terminal triage result, it must immediately notify the root coordinator of:

- Bug number;
- triage disposition;
- whether it was closed;
- whether S0 duplicate adjudication is required;
- any exceptional blocker.

This is a coordinator wake-up event.

It is not a user-facing notification.

Workers must not communicate directly with the user.

## S0 duplicate adjudication

After all individual triage workers have completed, but before releasing the triage barrier, inspect all suspected duplicate relationships involving two or more S0 issues.

If any exist, spawn one dedicated:

**`TRIAGE_MODEL` with `TRIAGE_REASONING` and best-effort `TRIAGE_TIER`**

duplicate-adjudication worker.

Provide that worker:

- the complete S0 inventory;
- all suspected S0 duplicate relationships;
- all relevant triage evidence;
- current issue states.

The duplicate-adjudication worker must:

1. evaluate each connected duplicate group;
2. determine whether the issues are actually duplicates;
3. choose the canonical issue where duplication is established;
4. avoid duplicate cycles such as A → B and B → A;
5. preserve the issue containing the clearest or most complete canonical problem statement where practical;
6. document the reasoning;
7. close only the issues adjudicated as duplicates;
8. leave the canonical issue in its appropriate triage state.

For each closed duplicate, record:

`closed-duplicate`

For the canonical issue, preserve or establish the correct remaining triage disposition.

The duplicate-adjudication worker must notify the root coordinator when adjudication is complete.

## Triage barrier

The root coordinator must not begin remediation until every issue in S0 satisfies exactly one of these conditions:

- `delegated-existing-parent`;
- `closed-nonreproducible`;
- `closed-duplicate`;
- `reproducible`;
- `uncertain-needs-remediation`.

Additionally:

- every individual triage worker must have completed;
- every suspected S0 duplicate group must have completed centralized adjudication.

Only then may remediation begin.

Update the root Epic with final triage counts before entering remediation.

## Worker safety and replacement

Run reproductions and tests in the repository's isolated fixtures, with
worker-owned home/XDG state, temporary roots, sockets, databases, and any test
daemon. Do not point destructive or state-changing reproductions at the user's
main LCM state or another worker's publication lock. Ordinary read-only project
memory access is separate from reproduction. If authentic reproduction requires
shared state that cannot be isolated, report the boundary instead of experimenting
on it. Never infer nonreproducibility from a broken fixture or unavailable runtime.

A failed triage worker is not a completed disposition. Replace it for the same
Bug with a worker that inherits the recorded evidence and completes the required
triage. Record the failed instance as superseded and ensure it cannot continue
mutating that issue. The barrier requires a completed valid triage assignment for
each non-delegated Bug, with no unresolved or still-running triage assignment;
it does not require a failed process to return successfully.

Centralized duplicate adjudication preserves outside ownership. A delegated S0
member can be the canonical target of another Bug's duplicate finding, but this
run never comments on, closes, reparents, or otherwise mutates that delegated
member. Preserve its `delegated-existing-parent` disposition even if it would
otherwise be the less complete report.
