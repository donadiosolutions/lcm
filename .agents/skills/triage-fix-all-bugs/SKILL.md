---
name: triage-fix-all-bugs
description: Use when asked to coordinate triage and remediation of all currently open native GitHub Bug issues in this repository. Not for a single issue or merely authoring or reviewing skills.
---

# Triage and fix all Bugs

## Directives and configuration

Execution authorizes two sequential phases within user scope: **triage, then
remediation**. Reading/editing/testing skills never authorizes workers, issue
mutations or environment replacement.

Defaults: `TRIAGE_MODEL=Luna`, `TRIAGE_REASONING=high`, `TRIAGE_TIER=priority`.
All can be overridden on invocation. This role also adjudicates duplicates.
Inherit [shared role parameters and limits](../procedural-development/SKILL.md#configuration).
Explicit invocation overrides caller configuration, then skill defaults; pass
resolved settings unchanged. These are invocation instructions, not CLI flags.
Shared route preflight and best-effort tier rules apply to every role.

Read repository/local instructions and project memory, [LCM integration](../shared/lcm-development.md),
[procedural-development](../procedural-development/SKILL.md) and both its references,
then [inventory/triage](references/triage.md) and [accounting](references/coordination.md)
in full. Apply shared root, event, recovery and route rules during triage without
starting remediation. Workers receive self-contained issue, scope and evidence briefs.

## Phase boundaries

`Bug` and `Epic` are exact **native issue types**; hierarchy uses native sub-issues.
Labels, title matches and checklists are not substitutes. Freeze S0 only after two
consecutive complete paginated native-Bug inventories agree; record T0, TF, parents
and exact default-branch SHA. Later issues/follow-ups never silently enter S0.

External native parents imply `delegated-existing-parent`: no mutation, reparenting,
triage or remediation, but retain the member in S0 accounting. An assignee alone
does not imply delegation. Finish every valid non-delegated triage assignment and
centralized S0 duplicate adjudication before remediation. Inconclusive reproduction
remains open as `uncertain-needs-remediation`.

## Shared environment contract

Supply LCM integration's startup, target-advance, watchdog and final operations.
Only the root acting as Environment Coordinator may mutate/replace/recover main
LCM, holding **`lcm-daemon-update`** through verification under the
[flock contract](../flock/SKILL.md). Explicit handoff and live-shell ownership apply.
There are no other workflow reservations; use isolated fixtures and preserve
application-internal locks.

## Remediation handoff

After the complete triage barrier, update final triage counts and invoke
`procedural-development` with the **same root, run ID and recovery record**:

| Input | Supply |
| --- | --- |
| Inventory | Only S0 `reproducible` and `uncertain-needs-remediation` items, with evidence, ownership and acceptance; retain full S0 accounting |
| Tracker | Existing root campaign Epic, checkpoint channel, native hierarchy and freeze metadata |
| Configuration | Resolved roles/limits and spent rounds; never reapply defaults or reset budgets |
| Delivery | Repository/LCM policy; native `Bug` P2 follow-ups linked to source/PR, outside S0 and campaign hierarchy, using pending PR links before publication |
| Resolution | `merged-resolved` requires a complete fix on default branch and verified source closure; incomplete fixes stay open |
| Environment/completion | Declared operations/resource and the [caller audit](references/coordination.md#final-audit) |

Shared procedures own remediation scheduling, planning/review, severity/budgets,
publication and recovery. The caller retains S0 dispositions, native hierarchy,
triage counters and terminal interpretation; do not duplicate the shared procedure.
