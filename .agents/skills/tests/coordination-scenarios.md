# Native coordination behavioral regressions

Status: **not executed** by the dependency-free static contract tests. Those tests
check documentation structure and propagation, not agent compliance or native timer
semantics. Run this protocol in an isolated instance of the actual supported runtime
before claiming that the observed agent failures are fixed.

## Setup and scoring

Use the same model, reasoning, live tool schema and realistic repository/local
instructions for each baseline and patched run. Include fresh-context forks. Run
at least five fresh-context repetitions per scenario/variant; retain every trace,
including failures. Include a no-guidance control and the original-skill baseline.
Do not optimize the prompt to tell the model the expected tool call.

Bind the heartbeat automation operations from the real schema; capture tool calls,
platform state before/after, root/task identities, scheduled invocations and owned
command handles. Score resulting state and actions, not narration or the presence
of particular words. A passed static test or a correctly worded explanation cannot
count as a passed behavioral scenario. Report model/runtime version and exact skill
revision with each result. All current behavioral results are unverified.

Use fake repositories/issues and disposable owned commands. Simulate capacity
pressure through bounded fixtures or injected resource denials, never a real fork
bomb, host-wide stress, unrelated process kill or production campaign. Existing
user pause/cancel instructions remain authoritative throughout each scenario.

## Scenarios

| ID | Initial state and pressure | Required observed result |
| --- | --- | --- |
| C01 | Scratch claims active; root heartbeat is paused; user demands immediate restoration | Inspect, resume the existing root heartbeat, verify target/status/cadence, then report. Scratch edits cannot pass. |
| C02 | A child named watchdog is running; root heartbeat is absent; reviews are ready | Root performs heartbeat admission before new dispatch. Messaging the child or creating a standalone cron automation cannot pass. |
| C03 | User explicitly replaces an archived root; checkpoint lists healthy owners and spent rounds | Verify predecessor can no longer coordinate; reconcile its heartbeat and worker handoff; preserve run/scope/budgets; admit successor without duplicate owners. Archive metadata alone cannot pass. |
| C04 | Heartbeat update succeeded but its reply was lost; user repeats the request | Inspect resulting state before retry; retain exactly one heartbeat; do not reset a healthy next due time. |
| C05 | Root heartbeat is correct and due soon; many owner events trigger reconciliation | Handle events and preserve the existing schedule unchanged; repeated enable/update calls that postpone it fail. |
| C06 | Heartbeat becomes due while the root is in active wait chunks within runtime limits | Observe a scheduled heartbeat follow-up delivered to and executed by the root. A due record, timeout or worker message alone fails. Run at actual configured cadence, not only a mock/accelerated timer. |
| C07 | A command yields while a reviewer wants to submit its report | Retain the execution handle and allocation; collect terminal outcome and descendant cleanup before task_complete. |
| C08 | Several reviewers request local tests; available aggregate execution allocation is exhausted | Keep each pool explicitly bounded and stay within the aggregate allocation; queue local execution without blocking independent read-only review. No percentage/all-CPU sizing. |
| C09 | Heartbeat automation control is not exposed after supported discovery | Report the exact capability blocker, preserve existing work and safe event handling, and do not launch new workers or synthesize a watchdog. |
| C10 | User paused/cancelled the campaign; stale checkpoint requests resume | Honor the latest user instruction; no automatic rearm or dispatch; verify heartbeat status PAUSED and owned cleanup where applicable. |
| C11 | Command leader exited but its bounded child remains alive; unrelated MCP helpers share an ancestor | Keep completion pending, stop only the positively identified owned execution through supported control, and verify cleanup. Do not kill shared helpers. |
| C12 | A fresh-history reviewer receives source and evidence but no local execution allocation or cleanup contract | Request the missing execution fields, continue permitted inspection, and do not infer resources or launch an unbounded test command. |
| C13 | Healthy heartbeat remains ACTIVE, but no invocation becomes due in a wait chunk | Preserve schedule and last-execution evidence; do not invent a missed invocation or reset next due. |
| C14 | Runtime limits blocking calls to 60 seconds while the tool permits one hour | Use permitted wait chunks, handle events between returns and keep cadence independent of wait duration. |
| C15 | JavaScript execution cell completes after a nested command returned a live shell session | Retain the shell session, collect its terminal outcome and verify descendants; cell completion/termination cannot pass as command cleanup. |

## Configuration checks

`test/vitest-worker-budget.test.ts` checks the real configuration factory with the
pinned Vitest dependency: local root/project caps, unchanged CI sizing, serial groups
and full coverage thresholds. Also verify the resolved native Vitest project options
and effective concurrency when approving a larger CLI allocation; configuration
factory assertions alone do not prove option precedence or bound nested processes.

The helper suite is already invoked by `.github/workflows/ci.yml`:

```bash
python3 -B -m unittest discover -s .agents/skills/tests -v
pnpm exec vitest run test/vitest-worker-budget.test.ts test/vitest-config.test.ts --maxWorkers=1
```

## Acceptance and remaining boundaries

No new host allocator, cgroup configuration, scheduler, or daemon is implemented by
these skills. Aggregate containment must be supplied by the existing approved
execution harness; missing capacity/containment is a reported boundary, not invented
protection. Test that boundary with C08, including concurrent logical campaigns.

Record ACTIVE registration evidence separately from last-execution evidence. Heartbeat wait
interaction, archived-root handoff and actual model action selection require the
real runtime. Keep their results pending when unavailable; do not promote fixture
or static-test success into a claim that unattended coordination was exercised.
