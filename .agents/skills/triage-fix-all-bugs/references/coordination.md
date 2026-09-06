# Root coordination and completion

Read the shared contract in [SKILL.md](../SKILL.md) before applying this phase.

**Contents:** Root responsibilities → LCM ownership and health → event handling → watchdog → counters → user communication → terminal states → final audit.

## Root coordinator responsibilities

The root coordinator is responsible for:

- preflight validation;
- establishing and validating S0;
- recording existing parent ownership;
- creating and maintaining the remediation Epic hierarchy;
- enforcing the triage barrier;
- launching centralized S0 duplicate adjudication where needed;
- maintaining up to 7 productive active Bug owners;
- replenishing remediation slots;
- best-effort conflict-aware scheduling;
- monitoring Bug-owner progress;
- maintaining overall counters;
- ensuring stalled or failed workers are noticed;
- handling truly necessary inter-agent deconfliction;
- maintaining the main LCM installation and daemon;
- communicating with the user.

The root coordinator is an orchestrator, not an implementation agent.

## Root coordinator prohibitions

The root coordinator must **not**:

- implement Bug fixes;
- edit bug-owner worktrees;
- perform implementation review;
- act as GLM, Grok, or Opus reviewer;
- take over implementation from an assigned implementer;
- hold exclusive source-file locks;
- serialize independent work unnecessarily;
- repeatedly interfere with healthy workers;
- micromanage bug owners.

The root coordinator should intervene in sub-agent work only when coordination genuinely requires it.

## LCM ownership

The root coordinator is the **only agent permitted to manage the main local LCM installation or main LCM daemon**.

No bug owner, reviewer, implementer, triage worker, duplicate adjudicator, or other sub-agent may:

- install LCM globally;
- replace the main LCM installation;
- restart the main daemon;
- stop the main daemon;
- upgrade the daemon;
- take ownership of its coordination lock.

Whenever a merge advances the default branch HEAD and therefore publishes a new LCM HEAD, the root coordinator must:

1. observe the current new default-branch HEAD;
2. acquire `lcm-daemon-update` as described below, then re-read the current default-branch HEAD and install that exact version using the repository's prescribed installation procedure;
3. verify the main LCM daemon is running;
4. verify the installed artifact identity and daemon health, record the evidence, then release the lock before returning to normal orchestration.

If multiple merges occur before the coordinator processes an LCM update, converge directly to the current default-branch HEAD rather than intentionally installing obsolete intermediate versions.

Use the repository [flock skill](../../flock/SKILL.md) with exactly the resource
name `lcm-daemon-update`. This is the **only exclusive resource in this workflow,
for every role**, across cooperating tasks on the same host. No additional
workflow locks or reservations may serialize source files, worktrees, tests,
databases, reviews, publication, or merges. Preserve LCM's internal correctness
locks and use isolated fixtures for worker tests.

Before any global installation, daemon mutation, or recovery, the root acquires
this resource in a dedicated Bash shell, starting at the repository root:

```bash
source .agents/skills/flock/scripts/lock.sh
lock 'lcm-daemon-update' || exit "$?"
# Run the prescribed artifact installation and health workflow in this shell.
# Record exact installed SHA, artifact identity, and health/test evidence.
exec 9>&-
```

Follow that skill's UUID and shared runtime-directory rules.
Keep this same shell alive, with descriptor 9 open, through the entire protected
operation, including required installation, connector, test, and health checks.
For multiple tool calls, retain one live interactive shell session; acquisition
in a completed one-shot call does not protect subsequent calls. Close descriptor
9 in background children that must outlive the operation, including a daemon
launched directly from this shell, so they cannot retain ownership after release.

On exit status 75, report the observed holder metadata and defer only the LCM
update. Continue unrelated campaign work; retry acquisition after release or an
explicit coordinator handoff. Never delete or replace the lockfile, steal the
lock, kill its holder, or treat stale metadata as ownership. Other acquisition
errors also prohibit the mutation until resolved. A handoff requires the old
holder to release and the new root to acquire successfully.

Release with `exec 9>&-` or shell exit when the protected operation finishes or
aborts, preserving failure evidence and pending recovery work on failure. Hold
no lock while idle or waiting for unrelated workers, reviews, or CI. After a
lost shell or resumed task, reacquire before further mutation and reconcile the
installed state; a run-record entry is not proof of a live lock. Read-only health
checks do not require exclusive ownership; any repair they trigger does.

## LCM health invariant

The main LCM daemon should remain up and healthy throughout the task.

The root coordinator must verify daemon health:

- at startup;
- before an LCM replacement or upgrade;
- after an LCM replacement or upgrade;
- during each periodic coordinator status check;
- whenever there is evidence that LCM may be unhealthy.

If the daemon is unhealthy, restoring it is a root-coordinator responsibility.

LCM recovery should not cause the root coordinator to begin editing Bug-owner worktrees or otherwise violate orchestration ownership.

## Event-driven coordinator behavior

The root coordinator should normally remain idle and allow sub-agents to work independently.

It should wake immediately for meaningful coordinator events, including:

- triage-worker completion;
- completion of duplicate adjudication;
- the triage barrier becoming satisfiable;
- a Bug owner parking work;
- a Bug owner becoming externally blocked;
- a PR opening;
- a PR becoming merge-ready;
- a PR merging;
- implementer escalation;
- worker failure;
- evidence of LCM failure.

Event-driven wake-ups should be used to keep work moving without continuously polling workers.

In particular:

- do not wait for the next 30-minute interval after all triage work has completed;
- do not leave remediation slots idle until the next periodic pass after a merge or park event.

## Periodic coordinator watchdog

Independently of event-driven wake-ups, every **30 minutes** proactively perform one coordination pass.

During that pass:

1. verify LCM daemon health;
2. inspect the state of every active Bug owner;
3. identify completed work;
4. identify failures;
5. identify stalled work;
6. identify parked or externally blocked Bugs;
7. replenish available remediation slots;
8. update the root Epic if appropriate;
9. emit a concise progress report.

The 30-minute pass is a watchdog and reconciliation mechanism.

It is **not** the primary mechanism for detecting normal state transitions.

Do not continuously poll workers between periodic checks unless an event requires immediate coordinator action.

## Progress counters

Maintain these counters explicitly:

- total Bugs in S0;
- delegated to existing parent;
- triage dispositions completed;
- closed during triage as non-reproducible;
- closed during triage as duplicate;
- eligible for remediation after triage;
- waiting for remediation;
- active remediation owners;
- PRs open;
- PRs merged;
- blocked or parked S0 Bugs;
- S0 Bugs escalated to Astra;
- S0 Bugs routed to Daybreak Blue;
- deferred P2 follow-up Bugs created;
- S0 Bugs remaining to terminal state.

`deferred P2 follow-up Bugs created` is a separate counter.

Deferred P2 Bugs are never included in:

`S0 Bugs remaining to terminal state`

Do not allow newly generated follow-up Bugs to change the immutable S0 denominator.

## Progress reports

Each 30-minute progress report should be brief and include at least:

- total Bugs in S0;
- delegated to existing parent;
- triaged;
- closed during triage;
- remaining after triage;
- waiting for remediation;
- active remediation owners;
- PRs open;
- PRs merged;
- blocked or parked S0 Bugs;
- Bugs escalated to Astra;
- Bugs routed to Daybreak Blue;
- deferred P2 follow-up Bugs created;
- S0 Bugs remaining to terminal state.

Include exceptional events only when useful.

Routine internal worker chatter should not be forwarded to the user.

## User communication

The root coordinator is the **only agent permitted to interact with the user**.

Sub-agents must never directly request decisions from the user.

If a sub-agent requires user input, it must send the root coordinator:

- the question or decision required;
- enough context to understand it;
- why the decision matters;
- available options;
- the safest reasonable default or reversible action, if one exists.

The root coordinator decides whether the user actually needs to be interrupted.

If user input is required for one Bug, continue all unrelated work rather than stopping the entire task.

Where a reversible or clearly safe default permits useful progress, prefer continued progress while the decision is unresolved.

Do not invent irreversible user decisions.

## Push notifications

Because this is expected to be a long-running task, the root coordinator may send push notifications to the user.

Use them only for meaningful events such as:

- a decision genuinely requiring user input;
- a major blocker;
- repeated worker failure;
- an orchestration failure that prevents useful progress;
- a significant completion milestone.

Do not send push notifications for normal sub-agent activity.

The regular 30-minute progress report is sufficient for routine progress.

Coordinator wake-up events and user push notifications are distinct concepts.

A worker waking the root does not imply that the user should be notified.

## Terminal S0 states

An S0 Bug is terminal only in one of these states:

1. `delegated-existing-parent`
2. `closed-nonreproducible`
3. `closed-duplicate`
4. `merged-resolved`
5. `blocked-genuine-external-condition`

`blocked-genuine-external-condition` may be used only when the Bug is genuinely blocked by a condition that the orchestration system cannot resolve autonomously and that condition has been explicitly reported to the user.

A temporarily parked Bug is **not** terminal merely because its active remediation slot was released.

## Completion condition

The task is complete only when **every issue in S0** has reached exactly one valid terminal state.

Before declaring completion:

1. verify every S0 issue has a terminal state;
2. verify every merged fix is reflected on the current default branch;
3. verify every deferred accepted P2 has a corresponding linked native `Bug` issue;
4. verify deferred P2 Bugs were not added to S0;
5. verify the root remediation Epic accurately reflects final status;
6. verify the complete tracking hierarchy is internally consistent;
7. verify the main LCM installation corresponds to the current default-branch HEAD;
8. verify the main LCM daemon is running and healthy;
9. verify no active Bug owner is still performing useful work on an S0 Bug declared terminal;
10. provide a concise final report.

The final report should include:

- total S0 Bugs;
- delegated-existing-parent;
- closed non-reproducible;
- closed duplicate;
- remediated and merged;
- genuinely externally blocked;
- escalated to Astra;
- routed to Daybreak Blue;
- deferred P2 follow-up Bugs created;
- final default-branch HEAD;
- LCM health status.

Do not declare completion merely because there are no active workers.

Completion is a property of the terminal state of **every member of S0**.

## Operational reliability

Apply these checks when wiring the run or recovering interrupted workers:

- **Deliver completion events.** At dispatch, establish a supported path that
  actually wakes the root when a worker finishes or needs intervention. Include
  Bug number, transition, worker ID, PR URL, candidate/merge SHA as applicable,
  and run-record location. Verify the first event is received and handled. A
  message saved in a worker transcript is not evidence that an idle root woke.
  If the runtime only delivers events during an active wait, keep the root in
  that supported wait while workers run; do not end the turn and assume it wakes.
- **Wire the watchdog separately.** Register a supported 30-minute wake-up for
  reconciliation and progress reporting. Include the run/Epic identity and
  record location so it resumes the same campaign. Reuse or update that run's
  existing watchdog on recovery; stop it after the final audit. Do not create a
  separate autonomous goal or replace event handling with periodic polling.
- **Verify the effective dispatch route.** A healthy model proxy alone does not
  establish that the current agent runtime exposes GLM, Grok, or Opus. Check the
  active dispatch catalog and effective settings. After a route failure, require
  a successful result through that route before restoring broad parallel use;
  an older worker's success does not prove fresh launches work. Unknown-model
  errors, unavailable tools, and provider tool-count limits are worker failures,
  not clean reviews. Reduce optional tool exposure when the supported surface
  permits it, while preserving access needed for an independent review.
- **Recover at the interrupted gate.** Preserve the worktree, candidate SHA,
  plan, completed reports, spent rounds, and P2 state. Retry only missing or
  failed reviews when the candidate SHA is unchanged; every new SHA still needs
  a complete review. Read worker reports after a purported recovery before
  declaring the route healthy. Do not restart a Bug or replace required models
  merely because the dispatch environment failed.
- **Respect shared services.** Authorization to manage the main LCM daemon does
  not authorize reconfiguring or restarting the user's Codex app-server, model
  proxy, or desktop connector. Diagnose the specific failing boundary, report
  any broader repair needed, and preserve affected candidates while unrelated
  work continues. Resume only after verifying that boundary works again.
- **Keep scope changes explicit.** A later user instruction may authorize a
  successor inventory or a different concurrency limit. Record that as an
  explicit run-contract revision with its own denominator and timestamp;
  preserve the original S0 record. New follow-up Bugs, runtime recovery, and
  idle workers never imply permission to expand S0 or exceed seven active owners.
- **Reconcile merge batches.** Record a fixed set of observed merge completions
  and verify their ancestry against the chosen current default-branch SHA before
  installing that artifact. If more merges arrive during refresh, preserve the
  pending events and converge to the newest observed HEAD. Do not mark later
  merges installed using an earlier artifact's evidence or lose their counters.
- **Preserve verification failures.** Keep the original failed environment-test
  log and file newly discovered Bugs outside S0 as required by repository policy.
  An unchanged reduced-concurrency retry can diagnose contention; it does not
  establish that the original concurrent failure was fixed. Do not change
  assertions, timeouts, skips, or required CI gates to manufacture a pass.
- **Recover watcher evidence.** Expired watchers or lost handles do not establish
  completion. Reconcile the known process, durable logs, and exit status; attach
  a fresh supported watcher where needed. Keep the environment handoff pending
  until test completion and daemon health have fresh evidence.
- **Repair audit metadata carefully.** A missing detector field is an evidence
  gap, not proof that a gate ran or failed. Reconcile canonical GitHub records and
  owner review/CI artifacts against the exact SHAs. Correct bookkeeping without
  repeating established gates; rerun only when evidence is absent or invalid.
  A merged PR alone does not prove all required reviews and CI passed.

These checks concern orchestration evidence. They do not authorize the root to
review or edit implementations, claim a worker's successful result on its behalf,
or infer current health from an older status report.
