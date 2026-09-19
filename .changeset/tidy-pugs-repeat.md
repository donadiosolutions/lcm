---
"@donadiosolutions/lcm": patch
---

Restore 7-day local event retention on SQLite installs. SessionStart prunes
processed passive-learning events older than seven days, but since the durable
PostgreSQL replication work landed, that prune also required each row to have
been acknowledged and pruned by a remote inbox. A SQLite-backed install has no
remote inbox and the schema cannot mark such a row acknowledged, so the prune
deleted nothing at all and the local events table grew without bound.
Retention now waits for remote proof only where PostgreSQL replication can
actually claim the rows. An event that never entered the remote pipeline is
reclaimed on age again, while any event still carrying remote state keeps the
full drained proof, so nothing is destroyed before replication has it.
