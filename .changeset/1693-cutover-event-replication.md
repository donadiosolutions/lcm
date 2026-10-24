---
"@donadiosolutions/lcm": patch
---

Deliver pending hook events that crossed a PostgreSQL cutover on the first
replication pass, and let `lcm events validate` accept their migrated copies.
A copy already in the project now matches the local event when they differ only
in the textual form of the creation time or in a `previousEventId` that only
the local side carries (values that both sides carry must still be equal). A
copy that is still pending is applied once, and one that was already applied is
acknowledged without a second apply, instead of failing the whole batch.
