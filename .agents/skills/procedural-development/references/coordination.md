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

Satisfy [native root admission](runtime-controls.md) before dispatch and establish
a supported worker-event path. Verify its first actual delivery. Bind messaging,
worker continuation and active wait to their exposed schemas; a worker message,
a new worker turn and a scheduled root invocation are distinct operations.

When the root has no ready action and is waiting for owners during triage or
implementation, invoke the native active-wait control directly. The requested
wait is one hour (3600000 ms); use the longest supported wait up to that duration
and the tool's actual argument units. Keep it independent of the periodic-check
cadence, not shortened to the next scheduled deadline. Verify scheduled delivery
and wake semantics as described in the runtime binding; do not infer delivery
from a due timestamp or assume a missed check will be caught by the next one.
After each return, handle owner messages and user input, reconcile actionable
events, and wait again while owner work remains pending and no ready action exists.
A timeout alone does not justify ending the root turn. Call native tools directly,
not inside an execution wrapper. Ending the root turn is not a wake-up mechanism.

Wake promptly on barriers, readiness changes, publication/merge requests or results,
parking, blockers, escalation, failure, deconfliction and environment failure.
Reevaluate affected dependency edges after internal merges, external updates and
recovery; record accepted evidence, source revision and rationale before admission.
The scheduler consumes caller-defined acceptance, never invents it. Refill slots
on events rather than waiting for the watchdog; do not busy-poll healthy workers.

Maintain one native periodic check on the current root at `WATCHDOG_MINUTES`
(30 minutes by default), with the logical run and recovery location available to
that root. Reconcile it through the bound control, not scratch files, child agents,
separate automations or sleeping processes. Preserve a correct registration across
ordinary events; renew only when the native lifecycle requires it. Active-wait
returns are neither watchdog passes nor reasons for user reports.
At each actual scheduled root invocation:

1. Run caller-supplied environment checks and reconcile owners, results, failures,
   stalls and parked blockers.
2. Reevaluate prerequisite evidence and refill productive slots.
3. Record the observed delivery separately from enabled-state evidence, reconcile
   the native check if renewal is required, and update meaningful checkpoint changes.
   Report meaningful progress, blockers or required decisions, not no-op passes.

Track fixed total, waiting/active/delivered/parked/blocked/remaining items, open and
merged PRs, escalations, security routes and deferred follow-ups, plus caller
counters. Keep follow-ups outside the original denominator.

Agent slots are not local-process capacity. Apply [execution lifecycle](execution-lifecycle.md)
to root commands and all workers; account for retained executions even after a
worker reports completion. Refill independent agent slots promptly within the
existing owner limit, while respecting the separate local-execution allocation.

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

### Evidence authority

Recovery records locate claims and evidence; they do not establish current runtime
state. Keep authority specific to the claim:

| Claim | Evidence |
| --- | --- |
| Authorized scope/acceptance | Current user instructions and accepted plan |
| Historical review or completed gate | Preserved report/artifact tied to the exact revision and gate inputs |
| Current Git/PR/issue state | Live Git/GitHub records |
| Current worker/command state | Native runtime, logs and terminal execution evidence |
| Current root periodic check | Native control state and separately observed scheduled deliveries |
| Held daemon-update mutex | Actual flock ownership, not descriptive metadata |

Preserve valid exact-revision history without pretending it describes the current
head. Read prior records to locate work, then reconcile operational claims against
the system that owns them; never repair reality by editing its description.

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

### Authorized coordinator replacement

An explicit user request to replace an archived/failed coordinator authorizes a
successor for that logical run, not takeover of another campaign. Preserve scope,
spent budgets, candidates and verified historical evidence. Record the predecessor
and successor root task IDs separately from the unchanged logical run ID.

Before successor dispatch or publication, verify through supported runtime controls
that the predecessor cannot continue coordinating; archive status or silence alone
is not that proof. Reconcile its periodic check: retain native evidence if already
inactive, otherwise disable/transfer it through native controls before establishing
the successor's check. Read back uncertain
handoff operations to avoid two live coordinators or two checks. An unverifiable
predecessor remains a specific handoff blocker, not permission to guess or kill
unrelated work.

Reattach healthy existing owners and their event paths where supported, obtaining
acknowledged reporting to the successor. Do not restart healthy work merely to
change coordinator identity. Replace an unusable worker only after reconciling its
executions and ensuring it cannot keep mutating; retain its evidence and budgets.
Reacquire any required daemon mutex under its existing handoff rules. Satisfy
native root admission for the successor before resuming unattended coordination.

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
  still productively owns an item declared terminal. Apply the execution-lifecycle
  completion gate, including commands left by workers that already reported done.
  Do not cancel healthy pending owners merely to make a root's final audit pass.
- Every supplied environment/final gate has fresh evidence; missing gates remain
  pending, not implicitly successful.

Report outcomes, delivered/blocked counts, remaining work, escalations, follow-ups,
target SHA and supplied environment results. Apply only caller-authorized tracker
closure. After final audit and permitted terminal accounting, disable the root's
native periodic check through its bound control and verify the result. A failed
stop remains pending cleanup, not successful shutdown. Do not stop a live campaign's
check just because its queue is temporarily empty.
