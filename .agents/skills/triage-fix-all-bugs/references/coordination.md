# Campaign accounting and completion

Read [the entrypoint](../SKILL.md), the
[shared coordination procedure](../../procedural-development/references/coordination.md)
and [LCM integration](../../shared/lcm-development.md). This reference owns only
triage-specific state, hierarchy and completion rules.

## Inventory and checkpoints

Keep full S0 and its denominator separate from the remediation subset. Persist
T0, TF, freeze SHA, native types/parents, hierarchy, triage evidence and dispositions
alongside shared candidate/review/round/PR and installed-artifact evidence. Give
the root Epic a stable run identifier, coordinator task/host, relative scratch
location and compact checkpoint. Update at meaningful transitions; keep private
absolute paths and secrets out of public tracking. Preserve successor recovery.

Inspect existing run Epics before creating one. Resume the same run when requested;
an unrelated open Epic alone does not block a new authorized run or authorize
takeover. Recheck parents immediately before attachment/dispatch; preserve external
claims and record delegation. Use shared recovery for uncertain writes/workers.

Incomplete, failed or changing enumeration leaves S0 unfrozen. A partial response
or fixed CLI limit is not an empty set. Do not mutate issues to stabilize it.
For validated empty S0, create the requested empty tracking Epic, launch no workers
and perform the normal audit. Explicit user scope changes are timestamped contract
revisions with their own denominator; preserve original S0. New Bugs or idle workers
never imply expansion.

## External closures and follow-ups

External closure never removes an item from S0. Read reason/evidence and have the
assigned worker validate disposition: established duplicate is `closed-duplicate`;
obsolete/fixed report verified on the default branch is `closed-nonreproducible`;
verified merged remediation with source resolved is `merged-resolved`. Record who
closed it and when; no second close is needed.

Unsupported automatic closures are not terminal evidence. Investigate, correct
state where justified or report a genuine external blocker. Delegated members
retain their no-mutation rule/disposition even as duplicate targets. Do not invent
a generic terminal state for unverified closures.

Deferred accepted P2 issues are native `Bug`, outside S0 and the campaign's native
hierarchy. Read back type, source/PR links and resolution at final audit. Preserve
valid fixes/duplicates/canonical successors; correct unsupported changes without
repeatedly reopening resolved work for counters.

## Counters and reporting

Add these caller counters to shared progress reports:

- Total S0; delegated to existing parent; completed triage dispositions.
- Closed nonreproducible; closed duplicate; eligible after triage.
- Waiting remediation; active owners; PRs open/merged; blocked/parked S0.
- Escalated S0 (`ESCALATED_IMPLEMENTER_MODEL` role); security-routed S0
  (`SECURITY_IMPLEMENTER_MODEL` role); deferred P2 follow-ups created.
- S0 remaining to a valid terminal state, excluding every follow-up.

The shared watchdog runs every `WATCHDOG_MINUTES` with this concise report.
Triage completion, duplicate-adjudication completion and a satisfiable barrier
are immediate events; do not delay remediation until a periodic check. Routine
worker chatter is not user-facing reporting.

## Terminal states

Every S0 member must end in exactly one validated state:

1. `delegated-existing-parent`
2. `closed-nonreproducible`
3. `closed-duplicate`
4. `merged-resolved`
5. `blocked-genuine-external-condition`

The last requires a condition the workflow cannot resolve autonomously and explicit
reporting to the user. Temporary parking is not terminal. Terminal accounting of
a genuine blocker does not claim its Bug was fixed.

## Final audit

Satisfy both shared final audit and all these caller gates:

- Every S0 member has one supported terminal state; no owner still productively
  works on an item declared terminal.
- Every merged fix is on current default branch and source closure is verified;
  unresolved/open source Bugs are not `merged-resolved`.
- Every deferred P2 has required native type, links and verified current resolution,
  and remains outside S0 and the campaign hierarchy.
- Root Epic, native hierarchy, dispositions and all counters reconcile.
- Main installed LCM matches current observed default-branch revision and the
  daemon/connector pass the shared integration's final checks.

Report total, delegated, closed nonreproducible/duplicate, merged-resolved,
genuinely blocked, escalated, security-routed, deferred follow-ups, target SHA and
LCM health. An empty worker queue does not satisfy these gates.
