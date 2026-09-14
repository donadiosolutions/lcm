# Native coordination controls

This is a behavioral contract, not an API definition. Bind it to the current
runtime's exposed tools; names, argument fields and return shapes below are not
invented tool calls. Reading/editing this reference does not authorize starting
workers, scheduling a campaign or changing host/runtime configuration.

## Bind the exposed controls

The current root reads the live tool schemas and runtime-specific installed guidance.
Use native discovery before declaring a control unavailable. Record these bindings
in workflow-local scratch, with the schema/source actually inspected:

| Capability | Establish from the runtime |
| --- | --- |
| Identity | Canonical current root/task ID and the scope of an implicit current-task target |
| Periodic check | Native inspect, enable/repair and disable operations for that root; check identity if exposed, cadence units/range and lifecycle/renewal rules |
| Evidence | Which native response or inspection establishes enabled state, target and cadence; how a scheduled delivery is observed |
| Active wait | Actual recipient, arguments, timeout units/maximum, event wake behavior and interaction with scheduled delivery |
| Worker events | Messaging versus starting a worker turn, delivery acknowledgement and supported recovery/reattachment |
| Execution | Launch/status/cancel operations, stable execution identity and owned-group cleanup evidence |

Use the tool's actual recipient directly, not a guessed wrapper or app-server
socket protocol. Do not assume a repository example describes the currently exposed
schema. Do not modify scheduler backing files, model proxies, the app server or
desktop configuration to manufacture missing capabilities. A separate scheduled
conversation or child watchdog is not the current root's native periodic check.

## Root periodic-check admission

1. Inspect the check belonging to the current root before campaign dispatch or an
   unattended wait. Reconcile any recorded identity with native state. Confirm the
   logical run/recovery context remains available to that root.
2. If already enabled for that root at WATCHDOG_MINUTES, retain it unchanged. Do not
   reset the next execution on every event. If absent, paused, wrong-target or wrong-
   cadence, use supported native operations to repair it. Reconcile predecessor or
   duplicate checks before enabling another; never change another campaign's check.
3. Inspect the result, or use an authoritative state response from the operation,
   to establish the current root target, enabled state and cadence. Implicit target
   semantics are acceptable only when the live schema binds them to this root.
   An accepted request with no state evidence remains unconfirmed.
4. Record the operation/inspection evidence and its observation time. Reuse the
   registration on recovery, renewing only when the native lifecycle requires it.
   Reconcile again after interruption, root replacement, an observed missing check
   or an explicit user correction. Intent recorded in run.json cannot pass this gate.

The caller's root performs these operations itself. A worker acknowledgement,
active subagent, timed wait, background process or edited record is not admission.
Initial admission need not wait 30 minutes for the first tick, but it cannot claim
an execution that has not occurred.

## Evidence and failure handling

Keep requested configuration, native enabled-state evidence and observed scheduled
execution separate. Record logical run/current root, check identity when exposed,
target/cadence evidence, operation result, inspection time, and actual delivery
identity/time when available. These are semantic evidence slots, not mandatory API
field names. Mark unavailable optional fields unobservable; do not invent values.

After a lost/ambiguous write response, inspect before retrying. Do not duplicate a
check, repeatedly postpone it or claim restoration from the written checkpoint.
Report enabled only with native evidence, and executed only after a scheduled root
invocation was actually observed. One observed tick is not proof of future delivery.

If a required control or essential state evidence is unavailable, report exactly
what was discovered, attempted and unconfirmed. Hold new unattended dispatch/waits;
preserve candidates, process available events and perform safe owned cleanup.
Do not abandon healthy existing workers or substitute another scheduler. Resume
admission when the capability is restored. A missing timer does not reset scope,
review budgets or valid historical evidence.

After permitted terminal accounting, disable the native check and verify its state.
Failure to disable remains pending cleanup. A temporarily empty queue is not terminal.

## Active wait and scheduled delivery

Request one hour of native active wait, capped by the exposed maximum and expressed
in the tool's actual units. Keep it independent of the 30-minute cadence; a wait
return is not a watchdog tick. Process events and repeat while owners remain pending
and no ready action exists. Do not end the root turn merely because a wait timed out.

Inspect whether scheduled checks can interrupt, be delivered during, or otherwise
wake that wait. Record first actual worker delivery and first scheduled-root delivery
separately. Do not infer either from a next-due timestamp. If runtime semantics queue
checks until the active turn ends and cannot support this wait/check combination,
report the incompatibility rather than certifying unattended supervision or silently
changing the cadence, spawning a timer worker or inventing a sleep loop.

Validate the interaction in an explicitly authorized isolated runtime exercise;
see [runtime acceptance scenarios](../../tests/runtime-scenarios.md). Production
campaigns do not authorize disruptive scheduler experiments merely by loading a skill.
