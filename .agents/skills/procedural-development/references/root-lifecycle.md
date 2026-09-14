# Root coordination lifecycle

Required for roots using [procedural-development](../SKILL.md), including Epic
execution and Bug triage. This defines admission and recovery, not another
coordinator, scheduler implementation or serialized workflow API.

## Codex heartbeat binding

The watchdog is a **heartbeat automation attached to the current root task**.
Use `mcp__codex_app__automation_update`, exposed through `functions.exec` as
`tools.mcp__codex_app__automation_update`. This is the native Codex app capability;
do not search for an additional undocumented periodic-check API. A heartbeat is
attached to a task; a `kind="cron"` automation runs standalone project work and is
not a substitute for this heartbeat.

Inspect the current session's live schema and `ALL_TOOLS` metadata when provided.
Tool availability can change after a harness repair or between roots and workers.
Product instructions alone do not prove a callable recipient. Use the exact
supported fields; never invent missing state or invocation-inspection tools.

1. Resolve the current task ID from runtime context. Inspect
   `$CODEX_HOME/automations/*/automation.toml` read-only for an existing matching
   `kind="heartbeat"`, `target_thread_id`, name and prompt. These files locate app
   records; do not edit them. For a matching ID call
   `automation_update({mode:"view", id: automationId})` and inspect its result.
2. If no matching heartbeat exists, call the exposed tool with `mode="create"`,
   `kind="heartbeat"`, `destination="thread"`, a descriptive `name`, a cohesive
   `prompt`, the cadence in `rrule`, and `status="ACTIVE"`. The `destination` field
   binds the calling task; alternatively use a verified `targetThreadId`. Omitting
   both is rejected. For the default cadence the tool value is
   `rrule="FREQ=MINUTELY;INTERVAL=30"`; derive the interval from `WATCHDOG_MINUTES`.
   Keep raw recurrence syntax in tool arguments, not user-facing status messages.
3. Repair or resume a known record with `mode="update"`, its `id`, and all preserved
   fields plus the intended change. Keep the current target, kind, name, prompt,
   cadence and notification policy unless authorized to change them. For an existing
   record, pass its verified saved `target_thread_id` as `targetThreadId`, including
   when a successor pauses the predecessor's heartbeat. Do not use
   `destination="thread"` from a different task to preserve the old target; that
   field selects the caller. Read back the saved target after the update. If this
   update binding is unavailable, report the cross-task operation as blocked.
   Pause with
   the same update operation and `status="PAUSED"`. Do not assume update/delete
   shapes on a surface whose live instructions do not support them.
4. Read back with `mode="view"`. Verify `viewStatus="found"`, `snapshot.kind`,
   `snapshot.status` (also returned as top-level `status`), and `snapshot.rrule`; creation/update acknowledgements alone are not
   readback. If the view omits the target, use the documented `destination="thread"`
   binding plus the app's saved `target_thread_id` to verify it. A returned
   `automationId` is the automation identity, not a separate invented check ID.

The prompt tells the root to reconcile its existing authorized run, preserve scope
and evidence, handle actionable changes, and pause the heartbeat after final audit.
Stay quiet on unchanged/non-actionable state unless the user requested periodic
reports; notify on meaningful change, completion, failure or required user action.
Honor notification policy fields as documented by the tool.

Readback verifies registration, not delivery. The current view does not expose a
next-run timestamp, last-invocation record, or a guarantee that scheduled work
interrupts an active wait. Mark those unexposed values accordingly. Only an actual
scheduled follow-up received in this task proves delivery; do not block registration
admission waiting for an invocation or claim delivery from `status="ACTIVE"`.

### Other exposed capabilities

| Surface, when exposed | Establishes | Does not establish |
| --- | --- | --- |
| `collaboration.list_agents`, `send_message`, `followup_task`, `wait_agent` | Current thread-tree agent state and communication under their documented semantics | Heartbeat registration or cross-root ownership transfer |
| `clock.sleep`, `clock__curr_time` | Waiting and time observation | A scheduled follow-up attached to the root |
| `functions.exec` and command tools | Tool orchestration and command execution | Scheduler liveness or an active heartbeat |
| `mcp__codex_app__list_threads`, `read_thread`, `wait_threads` | Accessible task status and history under their documented semantics | Transfer of collaboration worker ownership |
| `mcp__codex_app__handoff_thread` | Movement of another task and its Git state between supported checkouts/hosts | Coordinator succession or reassignment of its collaboration children |

Use collaboration tools for current-task subagents and app task tools for existing
user-owned tasks. Do not create a user-owned task as a substitute for a subagent.
An absent predecessor in `collaboration.list_agents` proves nothing about another
root; cross-root communication and command ownership still need explicit evidence.

## Admission

For an active campaign with work to dispatch or await, before the first worker
launch or unattended wait:

1. Resolve the current root task and inspect its heartbeat automation state.
2. Keep an already-correct active heartbeat unchanged, without resetting its schedule.
   Otherwise create, resume or repair that root's heartbeat at `WATCHDOG_MINUTES` using the
   heartbeat control. Read back uncertain operations before retrying; do not create
   duplicates. Do not repeatedly reset a healthy heartbeat's next execution.
3. Verify the resulting target, active state and cadence from platform evidence.
   Only then record the result and say the heartbeat is active. Only an observed
   scheduled invocation proves it has executed. Keep those claims separate.

A checkpoint edit, `PAUSED`/`ACTIVE` text, worker acknowledgement, live watchdog
subagent, timed wait, shell loop, standalone cron automation or another task's
heartbeat cannot satisfy this gate. Do not edit runtime automation files to bypass the heartbeat control.
The root performs this operation itself; sending a child a reminder is not repair.

Reconcile admission after resume, interruption, unexpected heartbeat loss or an explicit
user report that the heartbeat is absent. Address that report before unrelated progress
narration. A user pause, stop or cancellation takes precedence: do not automatically
rearm a deliberately paused campaign without renewed execution authority. Empty
inventory requiring only an immediate final audit needs no unnecessary watchdog.

## Evidence record

Record only observed values and evidence references, not desired-state assertions:

| Field | Evidence |
| --- | --- |
| Run | Preserved logical campaign ID and recovery location |
| Root | Current runtime task identity and supported targeting semantics |
| Binding | Actual automation_update view/create/update binding and preserved fields |
| Automation | Platform automationId |
| Status | Platform-returned ACTIVE or PAUSED state, not local checkpoint content |
| Cadence | Confirmed interval matching `WATCHDOG_MINUTES` |
| Observed | Inspection time and automation tool result reference |
| Next due | Platform next-run value when exposed; otherwise mark not exposed |
| Last execution | Observed scheduled invocation/result, or not yet observed |

Readback proves registration state, not scheduler liveness. On an observed missed
invocation, investigate the heartbeat delivery path rather than manufacture a pass or
quietly reset the due time. Keep owner event handling separate from watchdog passes.

## Unavailable control

Complete supported tool discovery once. If the heartbeat control cannot be invoked,
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
workers and executions; heartbeat automation readback establishes registration.
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
Reconcile its heartbeat and pause or retarget it through supported operations
before activating a replacement. Record the predecessor/successor relationship and
complete admission for the successor. Uncertain handoff is a blocker, not authority
to start a second root. This introduces no workflow lock or new autonomous task.

Reconcile existing workers and their command handles. Retain healthy work when the
runtime supports an explicit communication/ownership handoff; do not assume that a
new root automatically receives old messages. If that handoff is unsupported,
report the affected ownership boundary and preserve evidence before any authorized
replacement. Never duplicate an assignment just because its owner is in another
thread. Environment-Coordinator handoff still requires the existing mutex procedure.

## Terminal cleanup

After the requested final audit and permitted terminal accounting, pause the
heartbeat and verify its state. Also honor explicit pause/cancel instructions
without waiting for campaign completion. Uncertain pause stays pending and must
be read back, not described as stopped. Complete task-owned command cleanup under
[worker execution](worker-execution.md#completion); neither a stopped timer nor an
empty worker queue alone proves the campaign is complete.
