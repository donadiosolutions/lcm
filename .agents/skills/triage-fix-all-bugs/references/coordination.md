# Campaign accounting and completion

Apply [the entrypoint](../SKILL.md), [shared coordination](../../procedural-development/references/coordination.md)
and [LCM integration](../../shared/lcm-development.md). This reference adds only
triage-specific accounting and hierarchy rules.

## Directives

Keep full S0/denominator separate from its remediation subset. Persist T0, TF,
freeze SHA, native types/parents/hierarchy and triage dispositions/evidence alongside
shared candidate/review/round/PR and installed-artifact records. The root Epic records
stable run identity, coordinator task/host and relative scratch/checkpoint location;
keep private absolute paths and secrets out. Preserve successor recovery.

Resume requested runs; an unrelated open Epic neither blocks authorized new work
nor authorizes takeover. Recheck parents before attachment/dispatch and preserve
external claims. Partial, failed or changing enumeration stays unfrozen; a fixed
CLI result limit is not an empty set. Never mutate issues to stabilize enumeration.
Explicit scope changes retain original S0 and record timestamped revised accounting;
new Bugs or idle workers never expand scope.

## Reconcile closures and follow-ups

External closure does not remove an S0 member. Record who/when and have the assigned
worker validate the evidence: established duplicate is `closed-duplicate`;
obsolete/fixed report verified on default branch is `closed-nonreproducible`;
verified merged remediation with resolved source is `merged-resolved`. Do not close
again. Unsupported closures require investigation, justified correction or a genuine
external blocker, not a generic terminal state. Delegated members remain untouched.

Deferred accepted P2 findings are native `Bug` issues outside S0 and its native
campaign hierarchy. At final audit read back type, source/PR links and current
resolution. Preserve valid fixes, duplicates and successors; do not repeatedly
reopen resolved work to satisfy counters.

## Counters and events

Add these to shared checkpoints/watchdog reports: S0 total; delegated; completed
triage; nonreproducible/duplicate closures; eligible after triage; waiting/active
remediation; open/merged PRs; blocked/parked; escalated/security-routed items;
deferred P2 issues created; S0 remaining to valid terminal state. Follow-ups never
enter that remaining count.

Triage completion, duplicate adjudication and a satisfiable barrier are immediate
root events, not deferred to the `WATCHDOG_MINUTES` pass. Routine leaf chatter is
not user-facing reporting. Meaningful transitions update the existing checkpoint.

## Terminal states

Each member has exactly one validated state:

| State | Meaning |
| --- | --- |
| `delegated-existing-parent` | Protected external ownership, not a fix by this run |
| `closed-nonreproducible` | Verified obsolete/fixed report |
| `closed-duplicate` | Established canonical duplicate |
| `merged-resolved` | Complete default-branch fix and verified source closure |
| `blocked-genuine-external-condition` | Condition the workflow cannot resolve autonomously, explicitly reported to the user; not fixed |

Temporary parking is not terminal. Blocked accounting does not establish successful
triage-barrier completion or delivery.

## Final audit

For empty and nonempty S0, satisfy shared audit and verify:

- One supported terminal state per member; no worker productively owns an item
  declared terminal.
- Merged fixes exist on current default branch with source closure read back;
  open/unresolved sources are not `merged-resolved`.
- P2 follow-up types, source/PR links and resolutions are valid, outside S0/hierarchy.
- Root Epic, native hierarchy, dispositions and counters reconcile.
- Installed LCM matches current observed default-branch revision; daemon/connector
  and required artifact/tests satisfy integration gates.

Report total, delegated, nonreproducible/duplicate closures, merged-resolved,
genuinely blocked, escalated, security-routed, deferred follow-ups, target SHA and
LCM health. An empty worker queue alone satisfies none of these gates.
