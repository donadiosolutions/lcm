# Implement an Epic

The repository skill `implement-epic` applies the procedural-development
workflow to the planned descendants of a GitHub Epic. Invoke it with an Epic
identifier and, when useful, references to existing plans:

```text
Use $implement-epic for Epic #456 using plan references #457 and docs/epic-456-plan.md.
```

An agent that does not discover repository skills automatically can read
[the skill entrypoint](../.agents/skills/implement-epic/SKILL.md) directly.
This is repository tooling: it does not install tooling or create an LCM CLI
command. Writing, reviewing, or testing the skill does not execute an Epic.

## Scope and scheduling

The coordinator recursively discovers planned descendants of every GitHub issue
type below the Epic. It preserves the Epic and issue bodies while adding
checkpoint comments that identify the current plan, state, and evidence.
External blockers are documented but excluded from the ready-work inventory.
Accepted prerequisites establish dependency order; they do not close a
descendant. The coordinator schedules ready, independent work on a best-effort
basis and keeps blocked work visible for later resumption.

The coordinator retains the same root and run for planning, implementation,
publication, and merge. It is the only role that publishes or merges, reports
material events promptly, and provides an update at least every 30 minutes while
the Epic remains active. It does not create native follow-up parenting as part of
this workflow.

`implement-epic` passes its fixed remaining inventory and recorded readiness decisions to
[procedural development](procedural-development.md). The shared role defaults,
override precedence, model-route rules, exact-SHA reviews, three completed
candidate-review rounds, and P0/P1/P2/P3 handling are defined there. Overrides
remain agent instructions rather than CLI flags; for example:

```text
Use $implement-epic for Epic #456 with OWNER_MODEL=<model-id> and
IMPLEMENTER_TIER=priority.
```

Repository wrappers use the shared integration reference supplied outside the
portable procedure. The caller requires the repository
`flock` skill to acquire and release `lcm-daemon-update`, the sole hard mutex,
for main LCM installation and daemon mutation. Missing lock support blocks those
actions; it never authorizes unlocked mutation. Ordinary planning, implementation,
review and scheduling continue without additional locks.

## Completion limits

An Epic run completes only when every in-scope planned descendant has been
accounted for through the procedural workflow and the required publication and
merge steps have completed. The final report distinguishes merged work, deferred
P2 follow-ups, unresolved prerequisite work, and excluded external blockers.
An empty ready queue, a checkpoint comment, an accepted prerequisite, or a
blocked external dependency does not make the Epic complete.

The caller closes the Epic only when its own acceptance and closure criteria pass,
including required certification and current environment verification. A closed
prerequisite without accepted evidence does not release dependent implementation.
External blockers stay outside the execution inventory. New follow-ups use links,
not native parenting under the Epic, and never silently join the run on resume.
