# LCM development integration

Triage/Epic callers supply this repository policy to the shared workflow; it is
not a separate run.

## Directives

Read [AGENTS.md](../../../AGENTS.md), [WORKFLOW.md](../../../WORKFLOW.md), applicable
`AGENTS.local.md` and available `lcm-memory` context. In linked worktrees, locate
the primary with `git worktree list --porcelain` and read its local rules too.
Never copy or commit local instructions.

The root owns pushes, PR creation and merge commits; no squash/rebase merges.
Owners retain responsibility through verified source resolution. Preserve required
signatures, DCO, PR template/assignment, relevant local tests, exact-head required
CI with full 100% coverage, review-thread rules, docs and Changesets. Update Codecov
ownership atomically when production classification changes. Never bypass admission,
weaken gates or force-push without authorization.

Only the root acting as Environment Coordinator may replace the global installation,
mutate/recover the main daemon or acquire its lock. Arrange explicit handoff from
an existing coordinator; titles and recorded responsibility are not lock ownership.
No owner, implementer, reviewer, triage worker or adjudicator acts on its behalf.

## Exclusive resource and lifetime

The only workflow mutex is **`lcm-daemon-update`**, shared across runs on this host.
Use the [flock skill](../flock/SKILL.md), including canonical identity and a common
host runtime directory. Do not use worker fixture XDG roots for this mutex. No file,
worktree, test, database, review, publication or merge reservations; worker-local
fixtures and application-internal correctness locks remain in use.

Acquire in a dedicated live shell before global installation, daemon mutation or
recovery; retain descriptor 9 through artifact, connector, tests and health checks.
Release with `exec 9>&-` or shell exit on completion/abort. Close the descriptor in
long-lived children, including a directly launched daemon. One-shot acquisition
protects no later call; never hold ownership while waiting on unrelated work/CI.

Status 75 defers only the update: report observed metadata and continue unrelated
work. Other acquisition failures also prohibit mutation. Never steal/delete/replace
locks or kill holders. Handoff requires old release and new acquisition. After shell
loss/resume, reacquire and reconcile installed state. Read-only health checks need
no lock; repairs do.

## Environment procedure

| Trigger | Required operation |
| --- | --- |
| Startup | Verify main daemon health; preserve failure evidence and acquire before recovery |
| Observed default-branch advance/post-merge | Refresh exact installed artifact and verify under mutex |
| Watchdog | Read-only health check; report failures and perform authorized locked recovery |
| Final audit | Prove installed revision matches current observed default branch, with complete artifact/test/connector evidence and healthy daemon |

Check health before/after replacement and whenever evidence suggests failure.
The root owns recovery, not edits to owner worktrees.

For target advancement, record pending merges, acquire, then re-read current
default-branch SHA and verify the batch's ancestry. Use the primary worktree,
preserving unrelated changes and fast-forwarding clean main. Follow the exact
[artifact procedure](../../../AGENTS.md#local-environment-stability) and
[verified toolchain](../../../docs/development.md): build, pack and install an
independent tarball, never a global link. Verify installed identity/contents against
that artifact, installation, `lcm doctor` with zero failures, required tests and
only the active runtime's native connector install/doctor.

Record installed SHA, artifact identity and test/health evidence before releasing.
Coalesce to the newest observed target; retain arrivals during refresh and converge
afterward. Older artifact evidence cannot certify later merges. Pending refresh or
failed verification blocks final environment audit, not unrelated work or ready PRs.

Preserve original failure logs and file discovered Bugs outside run scope under
repository policy. Reduced-concurrency retries diagnose contention, not prove the
original failure fixed. Reconcile lost watchers through process/log/exit evidence;
do not weaken assertions, timeouts, skips or gates.

LCM authority does not authorize model-proxy, runtime app-server or desktop connector
reconfiguration. Diagnose and report that boundary, preserve candidates and continue
unrelated work. Route evidence is local/runtime-specific; tier control is best-effort,
never an LCM readiness gate.
