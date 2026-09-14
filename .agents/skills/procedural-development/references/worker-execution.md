# Worker execution ownership

Required for every root, owner, implementer, reviewer, synthesis reviewer, triage
worker and duplicate adjudicator. Role-specific delivery instructions do not
replace these rules. Read-only review protects candidate source; it does not make
a reviewer's test commands harmless or exempt from ownership.

## Required dispatch brief

Every dispatch supplies these fields, including `fork_turns="none"` and replacement
workers. Do not assume that an empty-history fork inherited parent instructions.

| Field | Supply |
| --- | --- |
| Assignment | Role, item, acceptance, frozen revision and permitted actions |
| Instructions | Applicable repository/local rules and this execution contract, as accessible paths or necessary inline content |
| Workspace | Worker-owned checkout and private home/XDG/temp, artifact, socket and database locations |
| Budget | Assigned local execution allocation, explicit worker/process limits and finite command deadline; distinguish these from agent slots |
| Execution ownership | Responsible worker, command/session handles to retain, and supported cancellation/cleanup mechanism |
| Completion | Report contract, terminal execution evidence and descendant cleanup or authorized persistent-job handoff |

Workers read supplied instructions before execution. Missing assignment or required
execution fields are requested from the parent; do not guess them. Missing local
execution capacity blocks resource-consuming commands, not assigned code inspection
or other work that does not consume that capacity. Pass applicable user invariants
to children; a path is sufficient only when the child can actually read it.

## Resource admission

Agent parallelism is not a host resource allocation. Account separately for active
local commands, each command's workers, and subprocesses spawned inside tests.
The root coordinates within an existing host allocation shared with other runs;
no leaf may independently assume the host's full CPU or memory capacity.

Use explicit absolute concurrency limits, not automatic CPU-count or percentage
sizing. Local Vitest defaults to one worker; keep one worker per run unless the root
assigns a larger allocation within known host headroom. For focused tests use
`pnpm exec vitest run <selected-test-files> --maxWorkers=1`. The root assigns a
finite deadline and uses the runtime's existing execution envelope when available.
A yielding command does not release its execution allocation.

The local Vitest configuration caps the root, ordinary parallel project and
separate PostgreSQL configuration;
`CI=true` or `CI=1` preserves existing CI sizing. Do not set CI or override the cap
in local agent work to evade an allocation. Existing serial projects and full CI
coverage/admission remain unchanged. Verify effective limits when using an approved
larger allocation; do not assume an argument was honored.

Use supported task-owned process, CPU and memory limits supplied by the execution
harness, including its aggregate host/run budget. Per-run Vitest limits alone do
not bound nested subprocesses or aggregate consumption. If a required allocation
or containment mechanism is unavailable, report the boundary rather than implement
new cgroups, host configuration or a workflow mutex during the assignment.

Never launch an unbounded or host-stressing process tree, even when it is a bounded
test pool rather than technically a fork bomb. Reproduction that needs host-wide
resource exhaustion must use isolated bounded fixtures or deterministic injection;
otherwise report it as unsafe to reproduce. Do not weaken assertions, coverage,
timeouts or CI gates to manufacture success. Watches and persistent jobs require
explicit user authorization, not convenience or a desire to keep a worker alive.

## Command lifecycle

Before launch, establish the worker-owned execution handle/group, allocation,
deadline and supported cancellation path. Retain the returned handle through tool
yields, waits and recovery. Follow the original execution to a terminal exit or
supported cancellation; a tool timeout, lost watcher or partial log is not evidence
that the command exited. Inspect existing execution state before any retry.

Reviewers run tests only against their own isolated frozen checkout and private
fixtures/artifacts; candidate source must remain unchanged. Verify revision and
tracked-source integrity before and after review. Generated output in private
locations is permitted; modifying the owner's checkout is not. Implementer and
triage fixture isolation applies equally to reviewers and adjudicators.

On deadline, cancellation or runaway behavior, stop the owned execution through the
supported runtime control and verify termination of its task-owned descendants.
Preserve logs and exit/cancellation evidence. Escalate unresolved containment to
the parent promptly. Target only positively identified owned executions; never
kill a shared app-server, MCP helper or unrelated worker merely because it shares
an ancestor, process name or cgroup. Do not reclaim another task's resources.

### Codex execution handles

Bind to the live schema; these handles represent different lifecycles:

- `functions.exec` can yield an execution-cell `cell_id`. Only after it reports
  `Script running with cell ID ...`, use `functions.wait` with that ID until the
  cell completes. Await every nested tool call before the JavaScript cell ends.
- `exec_command` can return a shell `session_id`. Retain it and use `write_stdin`
  with that session ID to collect the command's terminal exit, even if the outer
  JavaScript cell has already completed. Never pass a cell ID as a shell session ID.
- `yield_time_ms` limits time spent waiting for output; it is not a command
  deadline. Establish a finite execution deadline separately using an available
  task-owned harness or approved bounded command wrapper, and verify its cleanup.
- `functions.wait(terminate: true)` stops its execution cell. Its schema does not
  promise termination of a shell session or that session's descendants.
  `collaboration.interrupt_agent` similarly interrupts an agent turn without a
  documented process-cleanup guarantee. Neither is descendant-exit evidence.

Select cancellation from the command's actual transport. `write_stdin` sends bytes;
it is not a general process-tree kill API. A terminal interrupt requires a suitable
PTY and does not prove descendant cleanup. If the exposed tools cannot establish
owned-process containment and cleanup for a proposed command, keep that execution
pending, report the missing boundary, and continue safe inspection. Do not invent
`task_complete`, process-group cancellation, or CPU/memory-limit tool arguments;
a terminal assignment report uses the runtime's supported final-response path.

## Completion

Before `task_complete` or an equivalent terminal assignment report, reconcile every
command launched by the worker. Each must have terminal exit/cancellation evidence
and verified cleanup of its task-owned descendants. A successfully exited leader
does not prove its children exited. Missing handles or unobservable cleanup remain
pending and must be reported, not converted into success.

A persistent job may outlive the worker only when the user explicitly authorized
persistence and a live successor has acknowledged ownership of its handle, budget
and cleanup responsibility. Sending a message without acknowledgement, delegating
to an unowned child or writing a checkpoint is not a handoff.

Report candidate/revision, command handles, terminal outcomes, evidence locations
and cleanup or authorized handoff. A review may report a failed test after cleanup;
never call that test successful or suppress its evidence. The parent validates
this completion evidence before marking the assignment terminal, releasing its
execution allocation, accepting the report for a completed round, or replacing it.
No-command assignments say no commands launched instead of inventing exit evidence.
