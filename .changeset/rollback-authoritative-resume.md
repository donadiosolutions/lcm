---
"@donadiosolutions/lcm": minor
---

Add reversible migration rollback: reverse a completed PostgreSQL
activation back to SQLite. When PostgreSQL was activated but never written to
since, rollback flips the active backend selection back to SQLite
without copying any data. When
PostgreSQL has been written to since activation, rollback builds a
fresh SQLite generation from a fenced PostgreSQL snapshot, verifies
it independently before installing it, and preserves the prior live
database and the original pre-migration snapshot untouched. The
rollback publishes the SQLite selection through the same coordinator as
activation, refuses while another project is still bound to PostgreSQL (installation-wide
rollback is tracked by #1544),
and refuses a generation that never completed an activation, including one
whose project was never bound to PostgreSQL or whose configuration was switched
to PostgreSQL by hand (restore the configuration, or leave it with
`lcm migration abort`). A rollback refused after it entered its maintenance
window leaves PostgreSQL selected: the maintenance journal now records the
backend a window was entered from, and an aborted window keeps that backend
(an aborted activation still selects SQLite). Every step is resumable after a crash, including
after the selection flips and during the coordinator publication: a retry never guesses which
outcome already happened, an interrupted build never reuses a
partial generation, and an incomplete or failed attempt is kept as
evidence rather than deleted. The one exception is a prepared selection whose
PostgreSQL destination was written out of band before the retry: it refuses
fail-closed on every retry until #1529 adds an abort from that state. There is no operator-facing command
for this yet; it ships as an internal capability that a future
release will expose.
