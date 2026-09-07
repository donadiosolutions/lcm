# Coordination, recovery and completion

Apply [the run contract](../SKILL.md); preserve caller identity and budgets.

## Directives

Admit at most `MAX_ACTIVE_OWNERS` productive owners. Parking releases a productive
slot, not necessarily a runtime thread; account for the root, leaves and retained
workers against actual runtime capacity. Park only when external input/dependencies
prevent useful work. Cleared blockers require root readmission before work resumes.
Neither parking nor an empty worker queue proves completion.

Overlap scheduling is best-effort: dispatch ready work and merge ready PRs promptly,
without perfect conflict avoidance or file reservations. Owners resolve conflicts
in their own workspaces. Read-only preparation may precede readiness; implementation
waits for caller-required merged prerequisites and acceptance evidence.

Only the root communicates with the user. Owners send questions with context,
impact, options and a reversible default where available. Do not invent irreversible
decisions; progress independent work. Authorized push notifications are for decisions,
major blockers, repeated failures or milestones, not routine worker chatter.

## Scheduling and events

At dispatch establish a supported event path and verify its first delivery. Where
available, `send_message` delivers to a running recipient without starting a turn;
`followup_task` starts an existing worker's next task. When the root has no ready
action and is waiting for Bug owners or task owners during triage or implementation,
call `collaboration.wait_agent({"timeout_ms":3600000})` directly to stay running and
reachable. The default timeout is 3600000 milliseconds (one hour), the tool's
maximum. Keep this wait independent of the 30-minute scheduled watchdog; do not
shorten it to the next watchdog deadline. This allows one scheduled run to be
missed while the next run is still due within the one-hour wait window.
After each return, handle owner messages and user input, reconcile actionable
events, and call it again while owner work remains pending and no ready action
exists. A timeout alone does not justify ending the root turn. Call collaboration
tools using their live-schema recipients and arguments, not inside an execution
wrapper. Ending the root turn is not a wake-up mechanism.

Wake promptly on barriers, readiness changes, publication/merge requests or results,
parking, blockers, escalation, failure, deconfliction and environment failure.
Reevaluate affected dependency edges after internal merges, external updates and
recovery; record accepted evidence, source revision and rationale before admission.
The scheduler consumes caller-defined acceptance, never invents it. Refill slots
on events rather than waiting for the watchdog; do not busy-poll healthy workers.

Maintain one supported scheduled watchdog task every `WATCHDOG_MINUTES` (30 minutes
by default), carrying run identity and record location, alongside the one-hour
active wait. Reuse it on recovery, without creating another scheduled task or
autonomous goal. Shorter runtime wait returns are neither watchdog passes nor
reasons for user reports. At each actual watchdog pass:

1. Run caller-supplied environment checks and reconcile owners, results, failures,
   stalls and parked blockers.
2. Reevaluate prerequisite evidence and refill productive slots.
3. Update the permitted checkpoint and give a concise progress report.

Track fixed total, waiting/active/delivered/parked/blocked/remaining items, open and
merged PRs, escalations, security routes and deferred follow-ups, plus caller
counters. Keep follow-ups outside the original denominator.

## Environment procedure

Run only caller-defined startup, target-advance, watchdog and final operations,
using their authorized executors and declared locks. No supplied operations means
no implicit refresh. Read-only checks need no lock unless specified; repairs do.

For refresh, record a batch of observed merges/advances, acquire required ownership,
re-read target SHA and verify the batch's ancestry. Execute the caller's exact
artifact/verification procedure and record verified revision/evidence before
release. Retain newer events and converge afterward; never certify later merges
with an earlier artifact's evidence.

Contention defers only the protected action. Failed verification retains original
logs and pending recovery; it blocks required final environment gates, not unrelated
work. Lower-concurrency retries diagnose contention, not proof of a fix. Never
weaken assertions, timeouts, skips or CI to obtain a pass. Shared-service authority
does not authorize unrelated infrastructure repairs.

## Checkpoint and recovery procedure

Persist repository/target, frozen scope, root and worker IDs/routes/settings,
workspaces/branches, ownership/readiness, candidate SHAs, complete/incomplete rounds,
reports/adjudications, P2 state, PRs, environment evidence and pending events.
Use scratch plus only the caller's allowed tracker channel; preserve unrelated
tracker content. Public records use host/task identity and relative scratch paths,
not private absolute paths or secrets. Update meaningful transitions; successors
must locate evidence without guessing. Channel changes link prior evidence without
resetting run identity or budgets.

Before retrying an uncertain write, read back authoritative issue/ownership, worker,
PR-head, follow-up and environment state. Avoid duplicate workers, trackers,
comments, closures and merges. Recover the interrupted gate in the same workspace;
for unchanged SHA retry only absent/invalid reports, otherwise repeat all reviews.
A merged PR alone does not prove its required gates passed.

Silence, wait timeout or a lost watcher is not worker failure or completion.
Reconcile live state, durable logs and exit status; reattach a supported watcher.
Do not interrupt healthy work to reclaim capacity. Supersede a failed worker only
after ensuring it cannot keep mutating; preserve its evidence for replacement.
Repair missing bookkeeping from authoritative evidence without repeating proven
gates; rerun only absent/invalid evidence.

Validate external closures against caller dispositions, not bare closed state.
Preserve verified fixes, duplicates and canonical successors rather than reopening
resolved work for counters. New discoveries follow repository issue policy and
remain outside inventory unless explicitly admitted.

## Final audit

Even empty inventory requires all applicable predicates:

- Each item has one justified outcome. Distinguish delivered from caller-authorized
  blocked accounting; temporary parking is not terminal.
- Verify the **requested endpoint**: draft/PR delivery at its exact head, or merged
  delivery on the current selected target. Require the corresponding reviews,
  checks and source-resolution evidence; never turn no-merge scope into a merge.
- Deferred findings are actionable, correctly linked/classified or verifiably
  resolved, and outside the fixed inventory.
- Tracker, ownership, readiness, counters and recovery evidence agree; no worker
  still productively owns an item declared terminal.
- Every supplied environment/final gate has fresh evidence; missing gates remain
  pending, not implicitly successful.

Report outcomes, delivered/blocked counts, remaining work, escalations, follow-ups,
target SHA and supplied environment results. Apply only caller-authorized tracker
closure. Stop the watchdog after final audit and permitted terminal accounting.
