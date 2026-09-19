---
"@donadiosolutions/lcm": patch
---

Report a stalled daemon instead of retrying it forever. When the configured
storage backend is changed while a daemon is already running, that daemon keeps
the backend it authenticated at startup, so its background passive-event work
can never be admitted again. It previously retried on its five-minute sweep
interval indefinitely and only wrote a log line, so a machine could sit with
passive-event promotion silently stopped. The daemon now stops the sweep after
the first refusal, reports it once, and exposes a `passiveEvents` object with
`halted`, `haltedReason`, and `haltedMessage` on the unauthenticated
`/health` response for as long as the halt lasts. Health is the surface that
answers here, because every other route is refused under the same mismatch. The
next hook run still replaces the daemon and clears the halt.
