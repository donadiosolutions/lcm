---
"@donadiosolutions/lcm": patch
---

Deliver pending hook events that crossed a PostgreSQL cutover on the first
replication pass. The copy already in the project now matches the local event
when they differ only in the textual form of the creation time or in the
machine-local previous event id, so the event is acknowledged instead of failing
the whole batch.
