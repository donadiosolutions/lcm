---
name: implement-epic
description: Use when asked to execute or resume an existing planned native GitHub Epic and its required deliverables in this repository. Not for inventing a roadmap, triaging all Bugs, or merely authoring or reviewing skills.
---

# Implement a planned Epic

## Directives and configuration

`EPIC` is a required existing number/URL. `PLAN_REFERENCES` includes supplied planning
material and Epic references. Inherit [shared role parameters and limits](../procedural-development/SKILL.md#configuration);
explicit invocation overrides caller configuration, then shared defaults. Pass
resolved values unchanged; routing and best-effort tier rules apply to every role.
These are invocation instructions, not CLI flags.

Execution follows the existing plan, repository rules and explicit user limits.
Reading/editing/testing skills authorizes no workers, issue changes or installation.
Read [LCM integration](../shared/lcm-development.md), repository/local rules and
memory, then [procedural-development](../procedural-development/SKILL.md) and both
references. Preserve the same root/run/budgets; do not launch another coordinator.

## Assess and freeze

1. Resolve actual target branch/SHA and preflight routes, native types, hierarchy,
   dependencies, tracker and delivery access before mutation. Require a native
   `Epic`; missing plan/capability is a blocker, not permission to invent substitutes.
2. Fully paginate descendants and dependencies recursively. Read Epic/child
   acceptance, planning references, relevant code/merged changes and PR/run records.
   Include every required planned type and closed item, not merely open Features.
3. Record completed history and freeze remaining required deliverables with timestamp,
   target SHA and evidence after reconciling changing/partial enumeration. Nested
   Epics are outcome/checkpoint nodes, not duplicate implementation assignments;
   retain any distinct parent deliverable. Preserve optional/conditional decisions;
   required work closed `not planned` is not satisfied.
4. Before each dispatch recheck native parents, active ownership and PRs. Assignment
   alone is not exclusive ownership. Resume established owners/budgets; never take
   over another run, reparent its work or create competing owners. Externally owned
   required work remains in outcome accounting until accepted.

New discoveries/follow-ups stay outside frozen inventory unless explicitly admitted;
resume does not admit new children simply because enumeration now returns them.

## Readiness

Record ready, dependency-blocked, externally owned, completed and decision-blocked
items with reasons/evidence. Blockers outside planned descendants are **external
prerequisite references**, not new implementation scope; record owners only from
evidence. Build dependency edges with required acceptance, including GO/ADOPT results.
Closure/merge alone does not satisfy those results. Surface cycles, contradictions
and missing evidence while independent work proceeds.

The root remains readiness coordinator after internal merges, external changes and
recovery: record edge acceptance and release ready members in the same run. Read-only
preparation may precede prerequisites; dependent implementation waits for merged
prerequisite implementations and accepted evidence. Dispatch ready work promptly up
to the productive-owner limit, without a blanket phase barrier or perfect conflict
schedule. Refine plans within the journey; material scope/architecture decisions
belong with the user through the root.

## Execute and checkpoint

Invoke the shared workflow with the same root/run/recovery record, remaining
inventory, completed evidence, readiness graph, owners/budgets, resolved settings,
target and repository delivery policy. Shared procedures own implementation,
review, remediation, publication and recovery, including every later head change.
Supply all [LCM environment operations](../shared/lcm-development.md): only the root
owns global installation/daemon changes, and **`lcm-daemon-update` is the sole
workflow mutex**, acquired/released through [flock](../flock/SKILL.md).

Reuse the Epic without rewriting planning text, diagrams, acceptance, estimates or
unrelated comments. For a new run create one checkpoint comment and retain its ID;
resume the existing channel, linking old evidence if changed. Update meaningful
transitions, use safe relative public locations and read back uncertain writes.

Track total/completed required outcomes, remaining inventory, accepted/pending
edges, active/waiting/parked/external items, PRs, escalation/security routes,
follow-ups and verified environment revision. Watchdog reports include readiness;
leaf chatter stays local.

Deferred P2 findings are native `Bug` issues linked to source, candidate/review and
PR using the shared pre-publication pending-link procedure. Keep them outside the
executed Epic's native hierarchy and inventory; body links are sufficient.

## Outcome and closure

Combine shared audit with the Epic's actual closure contract:

- All required deliverables, certification and nested outcomes have accepted
  evidence on the relevant tested/merged revision.
- Conditional outcomes have affirmative decisions or explicitly permitted optional
  non-adoption with evidence. NO-GO is not success.
- Source resolutions, dependency evidence, PRs, follow-ups and metadata agree,
  preserving scope limits and external ownership.
- Current default-branch implementation, exact installed artifact, daemon/connector
  health and verification satisfy LCM integration.

Only the caller's root closes this Epic under invocation authority and those
criteria. Requested draft/no-merge endpoints may finish their bounded task without
satisfying Epic closure; leave the Epic open. Empty/completed journeys still receive
audit without unnecessary workers. Parked, delegated or genuinely externally blocked
required outcomes leave delivery incomplete and the Epic open. Report delivered/
remaining work, blockers, follow-ups, target SHA and environment evidence. Closing
this Epic never authorizes closing a parent/milestone with other required outcomes.
