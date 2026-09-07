# LCM integration for development callers

Read this from the triage or Epic caller before preflight. It is repository policy
supplied to the portable workflow, not a separate campaign.

## Repository admission and ownership

Read [AGENTS.md](../../../AGENTS.md), [WORKFLOW.md](../../../WORKFLOW.md) and
applicable `AGENTS.local.md`. For a non-primary local worktree, find the primary
with `git worktree list --porcelain` and read its local instructions. Use the
available `lcm-memory` skill for project context. Never copy/commit local rules.

The root executes pushes, PR creation and merge commits only (no squash or rebase
merge); owners supply evidence
and remain responsible through verified source resolution. Preserve signed commits
when required, DCO signoff, PR template/assignment, relevant local tests, required
exact-head CI with full 100% coverage, review-thread handling, docs and Changesets.
Maintain Codecov ownership atomically when production classification changes.
Do not bypass admission, force-push without authorization or weaken gates.

Before any global mutation, establish the root as Environment Coordinator. If
another coordinator owns that responsibility, arrange explicit handoff; its
responsibility and a run-record entry are not proof of lock ownership. No owner,
implementer, reviewer, triage worker or duplicate adjudicator may install LCM
globally, mutate the main daemon or acquire its lock on the root's behalf.

## Mutex and operation lifetime

Use the repository [flock skill](../flock/SKILL.md) to acquire **and release**
`lcm-daemon-update`. The exact resource is shared across cooperating tasks on
this host, including both callers. It is the only workflow mutex: do not add
file, worktree, test, database, review, publication or merge reservations.
Use worker-local fixtures and keep LCM internal correctness locks intact.

Follow flock's identity/runtime-directory rules. In a dedicated shell at the
repository root, source its helper and acquire before global install, daemon
mutation or recovery. Retain the same shell/descriptor through the full installation,
connector, test and health workflow. A completed one-shot acquisition protects no
later call. The current helper reserves descriptor 9; release with `exec 9>&-`
or shell exit on completion/abort. Close it in children that must outlive the
operation, including a directly launched daemon. Hold no lock while idle or
waiting on unrelated workers/CI.

Status 75 means contention: report observed metadata, defer only the LCM update,
continue unrelated work. Retry after release/handoff, without stealing, deleting
or replacing a lockfile or killing its holder. Other acquisition failures also
prohibit mutation. Handoff requires old holder release and new root acquisition.
On lost shell/resume, reacquire and reconcile installed state before mutation.
Read-only health checks need no lock; repairs do.

## Operations supplied to procedural-development

| Trigger | LCM operation |
| --- | --- |
| Startup | Verify main daemon health; preserve evidence and acquire before necessary recovery |
| Observed default-branch advance / post-merge convergence | Refresh exact installed artifact and verify health under mutex |
| Watchdog | Read-only daemon health; report failures, authorized recovery under mutex |
| Final audit | Prove installed revision matches current observed default branch, complete artifact/test/connector evidence and healthy daemon |

Also verify health immediately before/after replacement and when evidence suggests
failure. The root owns recovery without editing owner worktrees.

On target advance, record pending merge events, acquire, then **re-read** current
default-branch SHA. Verify the batch's ancestry and install that exact version using
the prescribed [artifact workflow](../../../AGENTS.md#local-environment-stability)
and [verified toolchain](../../../docs/development.md). Use the primary worktree
without disturbing unrelated changes; fast-forward clean main. Install the packed
independent artifact, never a global link. Verify installed identity/contents against
that tarball, installation, `lcm doctor` (zero failures), required tests and only
the active agent's native connector install/doctor.

Record installed SHA, artifact identity and health/test evidence before release.
Coalesce observed merges to newest current target, not obsolete intermediates.
If more arrive during refresh, retain them and converge afterward; do not mark
later merges installed from older evidence. Pending refresh or failed required
verification blocks final environment audit, not unrelated coding, review or
otherwise ready PR operations.

Preserve original failed environment logs; file discovered Bugs outside run scope
under repository policy. A reduced-concurrency retry may diagnose contention but
cannot prove the original failure fixed. Lost watchers require process/log/exit
reconciliation. Do not change assertions, timeouts, skips or gates to obtain a pass.

LCM authority does not authorize restarting/reconfiguring the user's model proxy,
Codex app-server or desktop connector infrastructure. Diagnose the actual boundary,
report broader repairs, preserve candidates and continue unrelated work. Shared
routing uses local/runtime evidence; service-tier control remains best-effort,
never an LCM readiness requirement.
