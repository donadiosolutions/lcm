# Inventory and triage

Apply [the entrypoint](../SKILL.md) and shared coordination/recovery rules.

## Directives

S0 is a stable operational enumeration, not a historical atomic snapshot at T0.
Never mutate candidate issues before freeze, treat partial/failed enumeration as
empty, or substitute labels/title/Projects fields for native `Bug`/`Epic` types.
Later issues and deferred findings remain outside S0.

External native ownership is protected throughout: delegated members receive no
comments, closure, reparenting, triage or remediation from this run. Assignment
alone is not delegation. Recheck parents immediately before attachment/dispatch.

Reproduce only in isolated repository fixtures: worker-owned home/XDG/temp roots,
sockets, databases and test daemon. Never experiment on main LCM state or another
worker's publication lock. Read-only project memory is separate. Unavailable runtime,
broken fixtures or unisolatable shared state are boundaries to report, not evidence
of nonreproducibility.

## Preflight and freeze

1. Determine actual default branch and exact HEAD. Verify native `Bug` and `Epic`
   types, sub-issue relationships/capacity, and access to enumerate types, create/
   type/attach/comment/close issues and create/merge PRs. Verify main daemon health
   under LCM integration. Missing capabilities block mutation/dispatch; no substitutes.
2. Record T0. Fully paginate open issues and select exact native `Bug` type. Repeat
   complete enumeration until two consecutive Bug sets agree. Do not attempt to
   reconstruct a transactional T0 snapshot from timelines.
3. Freeze S0 and TF; record each member's number, title, URL, type and parent, plus
   T0/TF and default-branch freeze SHA. Sanity-check the full list/count before any
   triage dispatch. S0 remains fixed; explicit scope revisions retain its evidence.
4. Mark externally parented members `delegated-existing-parent`, retaining their
   parent and denominator membership without taking over their hierarchy.

## Native tracker

Inspect existing run records first; resume the requested run, not an unrelated
open Epic. For a new run create one native root `Epic` with run identity and complete
S0 inventory, including externally owned members. Attach eligible S0 members as
native descendants, directly where capacity permits; use native child tracking
Epics for overflow. Those Epics are metadata, not S0 members. Omit no members and
never reparent delegated ones merely to complete the tracker.

Track delegation, triage, closures, queued/active remediation, open PRs, merged
resolution and blocked/parked states. Preserve existing checkpoint channels on
resume and reconcile uncertain writes before retrying. A validated empty S0 still
gets its new run's empty tracker and audit, but no workers.

## Individual triage

Dispatch one independent `TRIAGE_MODEL` worker per non-delegated Bug, parallel where
runtime capacity allows. Each assignment examines one Bug against freeze SHA or an
appropriate recorded newer default-branch SHA, and investigates possible duplicates.
Leave issue evidence sufficient for another engineer to verify the result.

| Evidence | Disposition/action |
| --- | --- |
| Positive evidence the report no longer applies under representative conditions or is fixed on default branch | Document reproduction, environment, revision, evidence and conclusion; close as `closed-nonreproducible` |
| Unambiguous duplicate of an issue outside S0 | Link canonical issue and document reasoning; close only this Bug as `closed-duplicate` |
| Suspected duplicate involving another S0 member | Record relationship/evidence and notify root; do not close either as a duplicate independently |
| Reproduced | Record reproduction/evidence; leave open as `reproducible` |
| Inconclusive | Record attempts and uncertainty; leave open as `uncertain-needs-remediation` |

A missing/broken reproduction environment never justifies closure. If authentic
reproduction cannot safely be isolated, report that boundary instead of using
shared state. Preserve delegated canonical targets without mutating them.

At a terminal triage result, immediately notify the root with Bug, disposition,
actual closure state, pending S0 duplicate adjudication and exceptional blockers.
This wakes coordination, not the user; workers communicate only through the root.

## Central duplicate adjudication

After individual assignments finish, dispatch one dedicated worker using the triage
role/settings if any S0 duplicate groups exist. Supply full S0, suspected connected
groups, triage evidence and current states. It independently validates duplication,
selects canonical problems, documents rationale and closes only proven duplicates.
Avoid cycles; prefer the clearest complete canonical report where ownership permits.
Preserve each canonical's correct disposition. A delegated member may be canonical
but remains untouched and `delegated-existing-parent`, even if less complete.
Report completed adjudication immediately to the root.

## Recovery and barrier

A failed worker is not a result. Reconcile its state, ensure it cannot keep mutating,
record it as superseded and replace the **same assignment** with inherited evidence.
Do not require a failed process to return successfully or retry proven evidence.

Release the triage barrier only when:

- Every S0 member is exactly one of `delegated-existing-parent`,
  `closed-nonreproducible`, `closed-duplicate`, `reproducible` or
  `uncertain-needs-remediation`.
- Every non-delegated member has a completed valid triage assignment, with no
  unresolved or still-running assignment; superseded instances are not extra gates.
- Every suspected S0 duplicate group has completed centralized adjudication.

Update final triage counts before remediation. An externally blocked assignment
requires an explicit incomplete-run report, not a fabricated barrier success.
