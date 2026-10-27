---
"@donadiosolutions/lcm": patch
---

Fix portable export and rollback of a PostgreSQL project whose passive-event
inbox still holds rows that the replication pass uploaded. Those rows carry the
local `previousEventId` pointer, which the export refused with
`record-unrepresentable`, so the whole project failed to export. The export now
accepts the pointer (absent, null, or a positive integer) and leaves it out of
the portable record, as the SQLite source already does.
