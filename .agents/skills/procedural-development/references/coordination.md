# Coordination, recovery and completion

Read [the shared contract](../SKILL.md) and preserve the caller's run identity.

## Scheduling and readiness

Maintain up to `MAX_ACTIVE_OWNERS` productive item owners. Fill slots promptly
from actionable inventory; park an item only when external input/dependencies
prevent any useful work. Parking releases capacity but is not completion. Resume
parked owners only after the root readmits them to a slot.

Use descriptions, acceptance criteria and likely components to reduce obvious
overlap. This is best-effort: do not delay ready work seeking a perfect schedule,
reserve source files, or wait to merge a ready PR for convenience. Owners handle
conflicts in their own workspaces. Respect runtime capacity across owners/leaves.

The root also remains the caller's readiness coordinator. At internal merge,
external prerequisite updates, relevant worker events and recovery, evaluate each
affected dependency's caller-defined evidence requirement. Record acceptance,
source revision and rationale before changing a waiting item to ready. The shared
scheduler consumes those recorded decisions; it never invents domain acceptance.
Read-only preparation may precede readiness, but implementation must wait for the
caller-required merged prerequisites and acceptance evidence. Newly ready members
stay in the same inventory/run. Blocked edges do not block unrelated ready items.

## Events and watchdog

At dispatch establish a supported event path that actually wakes the root, and
verify the first event is received/handled. A message written only to a leaf
transcript is insufficient. If delivery requires an active event wait, retain it
while workers run; do not end the turn and assume an idle task will wake.

Wake promptly for caller phase-barrier completion, readiness changes, publication,
merge readiness/completion, parking, blockers, escalation, worker failure,
necessary deconfliction and environment failure. Refill slots immediately rather
than waiting for the watchdog. Avoid continuous polling of healthy workers.

Separately arrange a supported `WATCHDOG_MINUTES` wake-up or active-wait deadline
with run identity and record location. Reuse it on recovery and stop it after final
audit. Do not create a separate autonomous goal. Bounded runtime wait returns do
not themselves require repeated polling or user reports. Each actual watchdog pass:

1. Run the caller's watchdog environment checks.
2. Reconcile active owners, completion, failures, stalls and parked blockers.
3. Reevaluate relevant prerequisite evidence and replenish slots.
4. Update the permitted tracker checkpoint and provide a concise progress report.

Track fixed inventory total, waiting, active, completed/delivered, parked/blocked,
open/merged PRs, escalated items, security-routed items, deferred follow-ups and
remaining items, plus caller-specific counters. Keep follow-ups outside the original
denominator. A zero-worker queue is not completion.

Only the root communicates with the user. Owners send questions with context,
impact, options and any reversible default to the root. Continue unrelated work
while waiting; do not invent irreversible decisions. Coordinator events are not
automatically user notifications. Use any authorized push mechanism only for
decisions, major blockers, repeated failures or significant milestones, not routine
worker chatter. Watchdog reports remain concise and separate from push alerts.

## Environment operations

Use only the operations and executors supplied by the caller for startup,
observed target advance/post-merge convergence, watchdog and final audit. No
environment operations means there is no implicit global refresh or service check.
Apply the declared flock contract before protected operations; read-only checks
need no lock unless specified, but repairs need their declared ownership.

Record a fixed batch of observed merges and pending target advances. Before a
refresh, acquire any declared resource, re-read the target SHA, verify the batch's
ancestry and run the caller's exact artifact/verification procedure. Record the
verified revision and evidence before release. If newer events arrive during the
operation, retain them and converge to the newest observed target afterward.
Never mark later merges installed using evidence for an earlier artifact.

Contention defers only the protected operation. Failed verification preserves
original logs and pending recovery; unrelated work can continue, but final audit
cannot silently waive the caller's environment gate. A lower-concurrency retry
may diagnose contention, not prove the original failure fixed. Never weaken
assertions/timeouts/skips or CI to manufacture success. Shared-service authority
does not authorize repairs to unrelated user infrastructure.

## Durable evidence and recovery

Maintain workflow-local scratch plus the caller's permitted tracker channel. Store
repository/target, scope freeze, coordinator identity, worker IDs/routes/settings,
worktrees/branches, readiness/ownership, candidates, completed/incomplete rounds,
reports/adjudications, P2 state, PRs, environment evidence and pending events.
Keep credentials out. Public checkpoints must not disclose private absolute host
paths; use shareable evidence or host/task identity plus relative scratch location.

Update checkpoints at meaningful transitions. A successor must be able to locate
evidence without guessing paths. Preserve tracker content outside the permitted
channel. With no tracker use scratch only. On checkpoint-channel change, record
the new identity and link prior evidence; do not reset the run or budgets.

Before retrying interrupted writes, reconcile issue ownership/state, existing
workers, PR heads, follow-ups and environment state. Read back uncertain outcomes
to avoid duplicate owners, trackers, comments, follow-ups, closures and merges.
Recover the interrupted gate with the same workspace and candidate. Retry only
missing/invalid reports for an unchanged SHA; new SHA means complete re-review.
Supersede failed workers explicitly so they cannot keep mutating concurrently.

Expired watchers/lost handles are not completion. Reconcile process state, durable
logs and exit status; attach a supported watcher as needed. Missing detector fields
are evidence gaps: reconcile authoritative PR/CI and review artifacts, repair
bookkeeping without rerunning established gates, and rerun only absent/invalid
evidence. A merged PR alone does not prove its required checks/reviews passed.

Report externally closed items to the caller for disposition validation. A bare
closed state cannot prove acceptance. Recheck follow-up classification and valid
resolution, preserving real fixes/canonical successors instead of reopening valid
closures for a counter. New discoveries follow repository issue policy and remain
outside the inventory unless the user explicitly revises scope.

## Final audit

The root combines shared and caller-specific evidence before reporting completion:

- Every inventory member has exactly one justified outcome; caller-authorized
  blocked accounting is distinguished from delivered work. Temporary parking alone
  is never a terminal result.
- All delivered changes are present on the chosen current target, with exact-head
  reviews/checks and required source-resolution evidence.
- Every deferred finding is actionable, properly linked/classified or verifiably
  resolved, and outside the fixed inventory.
- Tracker/ownership/readiness/counters and recovery evidence reconcile; no active
  owner is still working on an item declared terminal.
- Every supplied environment and final predicate has fresh evidence. Missing
  or unimplemented caller gates are pending, never implicitly successful.

Even an empty inventory receives this audit. Return item outcomes, delivered and
blocked counts, remaining work, escalations, follow-ups, target SHA and any supplied
environment results. Let the caller apply its own tracker-closure authorization
and domain criteria; do not independently close an arbitrary tracker. Stop the
run's watchdog only when the final audit and permitted terminal accounting finish.
