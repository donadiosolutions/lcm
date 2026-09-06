# Triage and fix all open Bugs

The repository skill `triage-fix-all-bugs` coordinates a complete campaign for
the open GitHub issues whose native type is `Bug`. Invoke it from an agent
working in this repository:

```text
Use $triage-fix-all-bugs to triage and remediate all currently open native Bug issues.
```

An agent that does not discover repository skills automatically can read
[the skill entrypoint](../.agents/skills/triage-fix-all-bugs/SKILL.md) directly.
The skill is repository tooling: it does not create an LCM CLI command or
change the installed `lcm-memory` skill.

## What the campaign does

The coordinator establishes an S0 snapshot before remediation. It obtains two
independent, complete GitHub inventories and proceeds only when they agree.
Native issue type, rather than labels, determines membership. The frozen
inventory is then triaged for reproducibility, duplicates, ownership,
and external blockers. Duplicate adjudication and the triage barrier finish
before the coordinator invokes
[procedural development](procedural-development.md) for accepted work.

The coordinator creates or updates the tracking Epic without taking issues from
an existing parent. It retains the same root coordinator and campaign run
through triage, implementation, publication, and the final accounting. It
reports meaningful events promptly and sends a progress update at least every
30 minutes while work is active.

The wrapper uses the repository's shared integration reference. It requires the repository
`flock` skill to acquire and release `lcm-daemon-update` for main installation and
daemon mutation. This is the only hard mutex; missing lock support blocks the
protected action, while unrelated triage, remediation and review continue.

Use the default triage route, or provide an agent-instruction override:

```text
Use $triage-fix-all-bugs with TRIAGE_MODEL=<model-id>,
TRIAGE_REASONING=high, and TRIAGE_TIER=priority.
```

`TRIAGE_MODEL`, `TRIAGE_REASONING`, and `TRIAGE_TIER` are instructions to the
agent, not command-line flags. The entrypoint defines separate defaults for
`TRIAGE_MODEL`, `TRIAGE_REASONING`, and `TRIAGE_TIER`: the model, high reasoning,
and a best-effort priority tier.
The shared role defaults and override rules are in
[the canonical configuration table](procedural-development.md#role-configuration).
An invocation value wins over a wrapper value, which wins over that table's
default. Runtime and local route mappings may translate a model identifier, but
the agent must preserve the requested model route and must not silently choose a
different model. Tier selection is best effort: omit it for a default tier and
continue if selection or observation is unavailable, without duplicating a
successful dispatch.

## Completion and follow-up work

The procedural workflow assigns up to seven independent owners, keeps the
coordinator as the only publisher and merger, and reviews every candidate at its
exact commit SHA. `REVIEWER_A` and `REVIEWER_B` independently review the plan and
every candidate SHA, then `SYNTHESIS_REVIEWER` reviews their reports, the plan,
and every candidate SHA. The initial budget is three completed candidate rounds; planning
or plan review does not consume a round. Later candidates still require full review. P0 and P1 findings block delivery in
every round. After the third completed candidate round, an accepted P2 is
deferred to a linked follow-up instead of causing escalation solely because it
remains P2. The owner adjudicates P3 findings.

Before a pull request is opened, each deferred P2 becomes an actionable native
Bug with source and review evidence. Its PR link may be pending until publication;
publication fills that link, and merge requires the completed record. Follow-up Bugs remain outside the frozen S0
inventory and do not recursively expand the campaign.

The final report accounts for each original Bug as triaged closed, delegated,
merged and source-resolved, or externally blocked with the reason reported.
It includes duplicate decisions, deferred follow-ups, escalations, the final
default-branch HEAD, and health of the shared integration. An empty worker queue,
a temporarily parked issue, or a blocked external dependency does not by itself
establish completion.

Writing, reviewing, or testing these skills does not start a Bug campaign.
