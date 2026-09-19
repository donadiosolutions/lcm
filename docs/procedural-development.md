# Procedural development

`procedural-development` is a portable GitHub workflow for taking either one
direct issue, a bounded caller-provided inventory, or a wrapper's accepted work
through planning, implementation, review, publication, and merge. It can be
copied to another GitHub repository because it does not install repository
tooling or create a new CLI command.

Invoke it for a single issue:

```text
Use $procedural-development to resolve GitHub issue #123.
```

Or pass a bounded set established by a caller:

```text
Use $procedural-development for the caller-provided inventory: #123, #124, and #125.
```

Documentation, authoring, or tests for the skill do not operate on GitHub
issues. A wrapper supplies its own admission and inventory rules; this workflow
does not rediscover or expand that inventory.

## Role configuration

The top-level shared skill table is the canonical default configuration. Values
such as `OWNER_MODEL=<model-id>` are instructions to the agent. They are not CLI
flags.

Read [the canonical configuration](../.agents/skills/procedural-development/SKILL.md#configuration)
for model, reasoning, and tier defaults. Each role has separate `*_MODEL`,
`*_REASONING`, and `*_TIER` parameters; callers inherit those values unless overridden.

For example:

```text
Use $procedural-development to resolve #123 with
OWNER_MODEL=<model-id>, OWNER_REASONING=high, and OWNER_TIER=priority.
```

Invocation overrides take precedence over wrapper overrides, which take
precedence over the table defaults. The agent resolves these instructions through
the active runtime and local route mappings, records the effective values, and
never silently substitutes a model. A priority-tier request is best effort: the
agent omits priority control for a default tier and does not block if it cannot
select or observe the requested tier. It also does not repeat a successful
dispatch merely because the selected tier cannot be observed.

## How work is controlled

One coordinator retains the run and is the only role that publishes or merges.
It schedules as many as seven issue owners when their work is ready and
independent. Owners plan, coordinate implementers, validate, and adjudicate their issue;
security-sensitive remediation uses the security implementer role. The
coordinator reports material events promptly. In Codex it registers a heartbeat
automation attached to the current task, with a default 30-minute cadence, through
`mcp__codex_app__automation_update`. The heartbeat revisits the same authorized run;
it does not create a standalone task. Unchanged state stays quiet unless you ask
for periodic reports.

Before dispatching campaign workers, the coordinator verifies the heartbeat's
`ACTIVE` status, cadence and target. A registered heartbeat does not prove that a
scheduled follow-up has executed. If the runtime does not expose the required
control, the coordinator reports that capability gap and preserves existing work
without claiming watchdog coverage. An explicit pause stops the heartbeat; an
ordinary resume preserves the run, scope and spent review budgets. Replacing a
coordinator additionally requires verified predecessor shutdown and worker handoff.
See the [heartbeat lifecycle contract](../.agents/skills/procedural-development/references/root-lifecycle.md)
for the exact tool binding and readback fields.

Workers own their command handles through terminal exit and descendant cleanup.
Active waits remain within runtime limits, independent of the heartbeat cadence;
a wait timeout or an interrupted agent does not prove that its commands stopped.

Each owner submits the review plan and every candidate commit SHA to two
independent reviewers: `REVIEWER_A` and `REVIEWER_B`. A separate
`SYNTHESIS_REVIEWER` assesses both reports, the plan, and every candidate SHA.
The owner adjudicates the findings and prepares a revised candidate when
required. The initial remediation budget is three completed candidate-review rounds.
Subsequent candidates still receive the complete review sequence; the spent P2
budget does not reset. Planning and plan reviews do not consume candidate rounds.

P0 and P1 findings always block delivery. An accepted P2 blocks before three
completed rounds; after the third completed candidate round it is deferred to a
linked follow-up and does not cause escalation solely because of its severity.
The owner adjudicates P3 findings. Before the pull request is opened, the
owner creates an actionable issue for every deferred P2, with the source
item and review evidence. Its PR link may remain pending until publication, which
must fill that link before merge.

Callers may explicitly set `FOLLOWUP_CHANNEL=private-record` to retain deferred
findings in their private campaign directory instead of publishing GitHub issues.
The default is `github-issue`; existing Bug and Epic campaigns keep that behavior.
Both channels require acceptance criteria, an owner, source and candidate links,
review/reproduction evidence, and a completed PR link before merge. Private records
remain outside the original inventory and their contents are not copied into public
PR text.

The workflow completes only after every supplied issue has an accounted outcome
and required publication and merge steps have finished. It reports limitations
such as an external dependency, unavailable access, unavailable exact model
route, or a failed required check. Those conditions may leave work blocked; they
are not completion.

## Optional shared resources

No locks or environment updates are implied by direct invocation. If a caller
requires mutual exclusion, it supplies the exact resource name, protected actions,
authorized executor, and the applicable `flock` skill. The workflow uses that
skill to acquire and release the resource in the same live shell across protected
operations and verification. A completed one-shot acquisition cannot protect a
later tool call. Missing lock support blocks only the protected action; unrelated
work continues. Copy the entire skill directory, including its references, when
reusing it; supply or discover `flock` only when a resource is declared.
