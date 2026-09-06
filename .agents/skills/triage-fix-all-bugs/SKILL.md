---
name: triage-fix-all-bugs
description: Use when asked to coordinate triage and remediation of all currently open native GitHub Bug issues in this repository. Does not apply to fixing one issue or authoring this skill.
---

# Triage and fix all Bugs

## Configuration

| Parameter | Default |
| --- | --- |
| `TRIAGE_MODEL` | Luna |
| `TRIAGE_REASONING` | high |
| `TRIAGE_TIER` | priority |
| Shared role parameters | Inherit [procedural-development defaults](../procedural-development/SKILL.md#configuration) |
| `MAX_ACTIVE_OWNERS` | Inherit |
| `WATCHDOG_MINUTES` | Inherit |

Add any shared parameter override here or to the invocation, including
`OWNER_MODEL`, `OWNER_REASONING`, `OWNER_TIER` and the corresponding parameters
for implementation, security, escalation and all three reviewer roles. Invocation
overrides win over this block, which wins over inherited defaults. These are agent
instructions, not CLI flags. The triage role also performs duplicate adjudication.
Apply shared route resolution and best-effort tiers to every role; unavailable
or unverifiable priority never blocks this campaign.

## Scope and read order

Run two sequential phases: triage, then remediation. An execution invocation
authorizes that campaign under the user's scope and repository rules. Reading,
editing or testing the skill does not launch a campaign or authorize issue
mutations, workers or LCM replacement.

Before work, read repository/local instructions and
[LCM integration](../shared/lcm-development.md), and use `lcm-memory` for context.
Read [procedural-development](../procedural-development/SKILL.md) and its
[coordination contract](../procedural-development/references/coordination.md)
for routing preflight, root boundaries, events and recovery. Apply those to triage
too, without starting remediation. Read [inventory and triage](references/triage.md)
and [campaign accounting](references/coordination.md) in full. Give triage workers
the relevant instructions, issue, frozen inventory and evidence.

- `Bug` and `Epic` are exact native GitHub issue types; native sub-issues establish
  relationships. Labels, title matches and checklists are not substitutes.
- Freeze S0 only after two consecutive complete paginated native-Bug inventories
  agree. Record T0, TF, parents and the exact default-branch SHA. Later issues and
  follow-ups never silently enter S0.
- A Bug parented outside the run is `delegated-existing-parent`: no mutation,
  reparenting, triage or remediation, but retain it in the denominator. An assignee
  alone does not trigger this disposition.
- Finish all individual triage assignments and centralized S0 duplicate
  adjudication before releasing the complete triage barrier. Inconclusive
  reproduction stays open as `uncertain-needs-remediation`.

## Only exclusive resource

The only resource requiring hard mutual exclusion is `lcm-daemon-update`.
Use the [flock skill](../flock/SKILL.md) to acquire and release it. Pass this
resource and its protected operations to `procedural-development`; do not
introduce additional workflow locks.

The root acting as Environment Coordinator is the sole executor for main LCM
installation/replacement, daemon mutation and recovery, including required
verification before release. Supply the shared integration's startup, target
advance, watchdog and final-audit operations. Follow its explicit handoff and
live-shell ownership rules. No role may reserve files, worktrees, tests, databases,
reviews, publication or merges. Isolated fixtures and internal correctness locks
remain in use.

## Invoke procedural-development after triage

Once the full barrier passes, update final triage counts and invoke
`procedural-development` with the **same root, run ID and recovery record**:

- Inventory: only S0 items dispositioned `reproducible` or
  `uncertain-needs-remediation`, with evidence, ownership and acceptance criteria.
  Retain the complete S0 denominator in the caller's accounting.
- Tracker: the existing root campaign Epic and its established checkpoint channel;
  preserve hierarchy and S0 freeze metadata.
- Configuration: resolved shared roles and concurrency; do not reset defaults or
  spent candidate rounds on invocation/resume.
- Delivery: repository instructions and [LCM integration](../shared/lcm-development.md).
  P2 follow-ups must be native `Bug` issues linked to source and PR, outside S0,
  without native parenting under this campaign. Preserve the shared pre-PR pending
  link procedure.
- Outcome: a complete merged fix must be present on the default branch and its
  source Bug closed with evidence/readback before `merged-resolved` is recorded.
  Never close incomplete fixes merely for accounting.
- Environment and completion: the declared resource/operations above and the
  [caller final audit](references/coordination.md#final-audit).

The shared skill owns all remediation scheduling, planning/review, severity and
round handling, publication and recovery mechanics. Do not maintain a second
remediation procedure here. The caller remains responsible for S0 dispositions,
native hierarchy, triage-specific counters and interpreting terminal outcomes.
