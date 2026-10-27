---
"@donadiosolutions/lcm": minor
---

Add the migration activation orchestrator: the cutover that switches one
verified, activation-eligible SQLite generation to its PostgreSQL destination.
Activation re-reads every precondition live before it changes anything (the
manifest and its verification report, the held maintenance window and writer
quiescence, the project's fenced lease, single-project stored-data coverage,
the destination identity, project-map and copy bindings, a fresh destination
census, and the authenticated target health), and a failed check is a refusal
that begins no effect. Once the checks pass it records durable evidence in a
fixed order (the sealed publication artifact, the generation link, the
activation epoch, attempt and witness, the witness and selection bindings),
publishes the PostgreSQL selection through the same coordinator rollback
uses, stores an immutable activation report and settles the manifest active.
Every step is resumable after a crash: a retry classifies the durable state
it finds and rolls forward, never re-mints an attempt a selection already
carries, and reports whether the publication is known to have been applied as
yes, no or unknown rather than guessing. A maintenance window entered from
PostgreSQL (a rollback window) is foreign to activation and is refused. A
non-predictive preview describes the durable state without taking locks or
touching PostgreSQL. Activation connects as the transfer role that copied and
verified the generation (its settings are supplied for both settings fields)
and admits the target through the transfer readiness check; it does not prove
that the daemon can start. The operator applies the runtime grants, revokes
the transfer grants and then starts the daemon, as docs/migration-cutover.md
describes. There is no operator-facing command for this yet; it ships as an
internal capability that #627 will expose.

