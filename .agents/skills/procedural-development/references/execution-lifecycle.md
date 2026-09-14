# Owned execution lifecycle

Applies to the root and every worker role, including read-only reviewers, triagers
and adjudicators. Agent completion and command completion are different events.
Reading this reference does not authorize a host stress test or infrastructure changes.

## Resource envelope

Keep independent agent lanes concurrent. Agent slots do not allocate CPU, memory,
PIDs or nested test workers. Before resource-heavy local execution, the parent
assigns explicit concurrency and the applicable host CPU/memory/process/time budget
from local instructions or approved harness limits, accounting for simultaneous
commands, nested pools, fixtures and retained executions across the host.

Default to one active resource-heavy local command per leaf and one test worker
per agent-local test command. Larger allocations must be explicit within the
aggregate envelope, not inferred from the host's advertised CPU count or a percentage
chosen independently by each leaf. A small per-command cap is not a host-wide cap.
A missing allocation defers the affected resource-heavy command, not unrelated
inspection, remote inference or safe cleanup. Do not add a workflow test mutex.

For LCM's Vitest runs, pass --maxWorkers=1 by default, or the explicit allocated
integer, including when using coverage. Use focused local tests and preserve full
CI coverage/admission. Confirm flags against the installed tool's help and verify
the effective worker behavior; a runner flag does not bound subprocesses created
inside a test. Watch mode, recursive runners and stress reproductions are not
implicitly authorized. Never create host-stressing or unbounded process trees,
whether or not their growth technically qualifies as a fork bomb.

Use existing harness-enforced execution groups/resource limits where available.
Do not install a new launcher, alter cgroups or raise host limits during a campaign.
Record enforcement gaps instead of claiming that an allocation note enforces a cap;
work requiring unavailable containment remains pending. Isolated fixtures and
application-internal correctness locks remain allowed. Resource limits must not be
used to weaken assertions, skip tests or disguise contention failures as fixes.

## Command lifecycle

Before launch, establish a bounded command, private fixture/artifact locations and
how the supported launcher provides identity, status, cancellation and cleanup.
Capture the real execution handle on acceptance; do not invent a pre-launch handle.
All roles use
private home/XDG/temp state, sockets, databases and services. Reviewers may write
private reports/build artifacts in disposable checkouts, never candidate source or
shared state; verify the reviewed revision and integrity before and after execution.

Retain the execution handle after any yielding tool return. A tool yield, turn end,
partial output or emitted task_complete is not terminal command status. Do not
rerun a command merely because its watcher was lost; reconcile the existing handle,
logs and live state first. Parents retain unresolved execution records even after
a worker claims to be done.

Before command-backed completion, collect terminal status and verify that the
command's task-owned descendants are gone. If cancellation is necessary, preserve
bounded evidence, target only the owned execution group through the supported
control, and verify termination. Never sweep shared app-server, MCP or harness
processes by name or ancestry; a shared ancestor does not establish task ownership.
A disappeared PID without terminal evidence is not a passing test.

A deliberately persistent job requires explicit user authorization, an identified
accepting owner, acknowledged handoff and continuing status/cleanup responsibility.
A test left running or a child asked to imitate the root watchdog is not a valid
handoff. Root coordination of intentionally pending owners is not abandoned work;
do not terminate healthy agents merely to satisfy this command lifecycle.

## Completion evidence

Every terminal worker report includes the applicable revision, commands/handles,
terminal outcomes with evidence locations, owned-descendant cleanup result, and any
explicitly authorized acknowledged persistent handoff. State that no commands were
launched when applicable; do not manufacture command evidence for inspection-only work.

Report unresolved execution or cleanup as pending/failed, not successful
completion. Do not emit task_complete while task-owned commands or descendants
remain unresolved. A parent receiving premature completion reconciles and preserves
valid report content, but keeps the assignment/gate incomplete until execution and
cleanup are resolved. Required tests must pass; cleanup alone cannot turn a cancelled
or failed command into validation. Preserve original outcomes and candidate budgets.
