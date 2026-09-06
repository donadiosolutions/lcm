---
name: implement-epic
description: Use when asked to execute or resume an existing planned GitHub Epic and its required deliverables in this repository. Does not create a new roadmap, triage all open Bugs, or launch work when merely authoring or reviewing skills.
---

# Implement a planned Epic

## Configuration

| Parameter | Default |
| --- | --- |
| `EPIC` | Required existing Epic number or URL |
| `PLAN_REFERENCES` | Supplied planning documents/tasks plus Epic references |
| Shared role parameters | Inherit [procedural-development defaults](../procedural-development/SKILL.md#configuration) |
| `MAX_ACTIVE_OWNERS` | Inherit |
| `WATCHDOG_MINUTES` | Inherit |

Add shared overrides here or to the invocation: `OWNER_MODEL`, `OWNER_REASONING`,
`OWNER_TIER` and corresponding implementation, security, escalation and reviewer
parameters. Invocation wins over this block, which wins over inherited defaults.
These are agent instructions, not CLI flags. Pass resolved values unchanged; use
shared routing and best-effort tiers. Unavailable/unobservable priority never blocks.

## Assess the existing journey

An execution invocation authorizes delivery within the existing plan under
repository rules and explicit user limits. Reading, authoring or testing this
skill does not launch workers, mutate issues or authorize environment replacement.

Read [LCM integration](../shared/lcm-development.md), repository/local rules and
project memory. Read [procedural-development](../procedural-development/SKILL.md)
and its references for routing preflight and shared mechanics. Resolve actual target
branch and current SHA. Before mutation verify access to native types, hierarchy,
dependencies, tracker updates and delivery operations. Require an existing native
`Epic`, not a label/title approximation. Missing plan/capabilities is a reported
boundary, not permission to invent a journey.

Fully paginate native descendants and dependencies recursively. Read the Epic,
child acceptance criteria, supplied planning/task references, relevant code/merged
changes and current PR/run records. Preserve explicit scope limits, acceptance and
closure rules. Include all required planned types, including Features, Bugs, Chores
and nested Epic outcomes; do not filter to features or only open issues.

Record completed history and a fixed execution inventory of remaining required
deliverables. Keep nested Epics as outcome/checkpoint nodes; allocate implementation
owners to actionable deliverables, not duplicate owners for parent/child work.
A parent with its own distinct deliverable keeps that explicit contract. Preserve
optional/conditional decisions and evidence; required work closed `not planned`
is not satisfied. Reconcile changing/partial enumeration before freezing, recording
timestamp, target SHA and evidence links.

Inspect native parents, active worker/run ownership and relevant PRs before each
dispatch. Assignment is context, not sufficient proof of exclusive ownership.
Resume established owners and budgets with evidence; do not take over another
active run, reparent its work or spawn competing owners. Externally owned required
deliverables remain in outcome accounting until acceptance is verified.

## Readiness and best-effort execution

Record ready, dependency-blocked, externally owned, completed or decision-blocked
items with reasons/evidence. Native blockers outside planned descendants are
**external prerequisite references**, not added implementation items. Do not assume
an owner; record one only from evidence. New discoveries/follow-ups stay outside
the frozen inventory unless explicitly admitted.

Build edges with caller-defined acceptance evidence, including required GO/ADOPT
results. Closure/merge alone never replaces those results. Surface contradictions,
missing evidence and cycles while continuing unrelated work. Refine implementation
plans within the agreed journey; material scope/architecture changes go through
the root to the user rather than silently rewriting the plan.

The root remains readiness coordinator throughout `procedural-development`.
After internal merges, external prerequisite changes and recovery, reevaluate
affected edges, record acceptance and release ready inventory members in the same
run. Shared scheduling consumes those decisions; no second coordinator is created.

Prepare contracts/investigate read-only before prerequisites finish. Dependent
implementation starts only after prerequisite implementations merge and acceptance
passes. Dispatch independent ready work promptly up to the productive-owner limit,
without a perfect conflict-free schedule or blanket phase barrier. Shared review
and round rules apply to every item and every later head change.

## Only exclusive resource

The only resource requiring hard mutual exclusion is `lcm-daemon-update`.
Use the [flock skill](../flock/SKILL.md) to acquire and release it. Pass this
resource and its protected operations to `procedural-development`; do not
introduce additional workflow locks.

Supply the root acting as Environment Coordinator as sole executor for main LCM
installation/replacement, daemon mutation and recovery, including verification
before release. Use [shared integration](../shared/lcm-development.md) for startup,
target-advance convergence, watchdog/final audit, handoff and live-shell ownership.
All roles use isolated fixtures, with no file/worktree/test/database/review/
publication/merge reservations. Internal correctness locks remain intact.

## Invoke procedural-development and maintain the tracker

Pass the same root/run/recovery record, fixed remaining inventory, completed evidence,
readiness graph, owners/budgets, resolved roles, target branch, repository delivery
policy and declared resource/environment operations. Delegate all bulk implementation,
review, remediation, publication and recovery mechanics to the shared skill.

Reuse the Epic without overwriting its planning body, diagrams, acceptance rules,
estimates or unrelated comments. For a new run, create one dedicated checkpoint
comment, record its ID and update at meaningful events. On resume retain the existing
channel; if changed, link prior evidence and preserve run/budgets. Public checkpoints
use safe relative evidence locations, not private absolute paths. Read back uncertain
writes before retrying.

Track total/completed required outcomes, remaining inventory, accepted/pending edges,
active/waiting/parked/externally owned items, PRs, escalations, security routing,
follow-ups and verified environment revision. Watchdog progress includes readiness;
normal leaf chatter stays local.

Deferred findings are native `Bug` issues with source, candidate/review and PR links
under the shared pre-PR pending-link procedure. Never natively parent them under
the executed Epic; use body links/cross-references. Resume does not admit follow-ups
or new children just because GitHub now shows them.

## Outcome and closure

Combine shared final audit with the Epic's actual closure contract:

- Every required outcome, including certification/nested outcomes, has accepted
  evidence on the relevant tested/merged revision.
- Conditional outcomes have required affirmative decisions or explicitly permitted
  optional non-adoption with evidence; never reinterpret NO-GO as success.
- Source resolutions, dependency evidence, PRs, follow-ups and metadata agree;
  preserve scope limits and externally managed work.
- Current default-branch implementation and exact installed LCM artifact,
  daemon/connector health and verification satisfy shared integration.

Only the caller's root closes the Epic under invocation authority and the Epic's
criteria. Empty/already-completed journeys still receive the audit, without
unnecessary owners. Parked, delegated or genuinely externally blocked required
outcomes leave the Epic open and delivery incomplete even with no workers.
Report delivered/remaining work, blockers, follow-ups, target SHA and environment
evidence. Closing this Epic does not authorize closing a parent or milestone
with other required outcomes.
