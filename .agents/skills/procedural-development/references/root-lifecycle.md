# Root coordination lifecycle

Required for roots using [procedural-development](../SKILL.md), including Epic
execution and Bug triage. This defines admission and recovery, not another
coordinator, scheduler implementation or serialized workflow API.

## Native binding

The watchdog is the **native periodic check attached to the current root task**.
Discover its inspect, enable/update and disable operations from the live runtime
schema and runtime instructions. Record the exact supported tool recipients and
arguments once; invoke those tools directly. This document supplies no invented
API name. App-wide automations and worker messaging are different capabilities.

Confirm how the native check targets this root, exposes enabled state and cadence,
and delivers a scheduled invocation while the root is in an active wait. A
root-scoped operation may establish its target through documented runtime context;
never fabricate a missing check ID or next-run timestamp. A documented operation
result that returns current state is usable evidence; a mere acknowledgement of
an update request is not a state readback.

## Admission

For an active campaign with work to dispatch or await, before the first worker
launch or unattended wait:

1. Resolve the current root task and inspect its native periodic-check state.
2. Keep an already-correct enabled check unchanged, including its next due time.
   Otherwise enable or repair that root's check at `WATCHDOG_MINUTES` using the
   native control. Read back uncertain operations before retrying; do not create
   duplicates. Do not repeatedly reset a healthy check's next execution.
3. Verify the resulting target, enabled state and cadence from platform evidence.
   Only then record the result and say the check is enabled. Only an observed
   scheduled invocation proves it has executed. Keep those claims separate.

A checkpoint edit, `PAUSED`/`ACTIVE` text, worker acknowledgement, live watchdog
subagent, timed wait, shell loop, cron job or separate automation cannot satisfy
this gate. Do not edit runtime automation files to bypass the native control.
The root performs this operation itself; sending a child a reminder is not repair.

Reconcile admission after resume, interruption, unexpected check loss or an explicit
user report that the check is absent. Address that report before unrelated progress
narration. A user pause, stop or cancellation takes precedence: do not automatically
rearm a deliberately paused campaign without renewed execution authority. Empty
inventory requiring only an immediate final audit needs no unnecessary watchdog.

## Evidence record

Record only observed values and evidence references, not desired-state assertions:

| Field | Evidence |
| --- | --- |
| Run | Preserved logical campaign ID and recovery location |
| Root | Current runtime task identity and supported targeting semantics |
| Binding | Actual native inspect, enable/update and disable recipients/schema |
| Check | Platform check ID when exposed; otherwise mark not exposed |
| Enabled | Platform-returned current state, not local checkpoint content |
| Cadence | Confirmed interval matching `WATCHDOG_MINUTES` |
| Observed | Inspection time and native tool result reference |
| Next due | Native next-run value when exposed; otherwise mark not exposed |
| Last execution | Observed scheduled invocation/result, or not yet observed |

Readback proves registration state, not scheduler liveness. On an observed missed
invocation, investigate the native delivery path rather than manufacture a pass or
quietly reset the due time. Keep owner event handling separate from watchdog passes.

## Unavailable control

Complete supported tool discovery once. If the native control cannot be invoked,
its target/cadence cannot be met, or its state cannot be verified, report the exact
capability or verification blocker. Do not build a substitute, change the app-server
or claim unattended supervision. Do not launch new campaign workers through this
failed admission gate. Preserve existing work, receive available events and perform
safe containment; missing supervision alone does not authorize killing healthy work.
Read-only recovery and diagnosis can proceed without falsely declaring admission.

## Recovery authority

The checkpoint is an index of claims and evidence, not authority over live systems.
Current user instructions and accepted scope govern what is authorized. Preserved
exact-revision reports establish historical review evidence; Git/GitHub establish
current heads and issue states; native runtime and command evidence establish live
workers and executions; native periodic-check evidence establishes supervision.
Actual lock ownership, not descriptive metadata, establishes mutex ownership.

Read records to locate evidence, then verify operational claims against the owning
system. Do not rerun valid historical gates merely because their worker has exited.
Do not treat a historical approval as approval of a newer revision. Unknown live
state remains unknown, not active, completed or failed by inference from silence.

## Coordinator replacement

Preserve the logical run ID, scope, budgets, workspaces and verified historical
artifacts. Keep the current runtime root identity separate from that run ID.
Ordinary resume retains the root; an explicit user request to replace an archived
or failed coordinator authorizes a successor, not a competing campaign.

Before assuming coordination, verify that the predecessor can no longer coordinate
or mutate the campaign; archive status or a checkpoint label alone is insufficient.
Reconcile its native check and stop or retarget it through supported operations
before enabling a replacement. Record the predecessor/successor relationship and
complete admission for the successor. Uncertain handoff is a blocker, not authority
to start a second root. This introduces no workflow lock or new autonomous task.

Reconcile existing workers and their command handles. Retain healthy work when the
runtime supports an explicit communication/ownership handoff; do not assume that a
new root automatically receives old messages. If that handoff is unsupported,
report the affected ownership boundary and preserve evidence before any authorized
replacement. Never duplicate an assignment just because its owner is in another
thread. Environment-Coordinator handoff still requires the existing mutex procedure.

## Terminal cleanup

After the requested final audit and permitted terminal accounting, disable the
native check and verify its state. Also honor explicit pause/cancel instructions
without waiting for campaign completion. Uncertain disable stays pending and must
be read back, not described as stopped. Complete task-owned command cleanup under
[worker execution](worker-execution.md#completion); neither a stopped timer nor an
empty worker queue alone proves the campaign is complete.
