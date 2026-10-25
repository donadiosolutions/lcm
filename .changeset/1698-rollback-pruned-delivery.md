---
"@donadiosolutions/lcm": patch
---

Rollback from PostgreSQL to SQLite now accepts local passive events that the replication worker delivered and whose PostgreSQL inbox rows it then pruned, instead of refusing them as events PostgreSQL does not hold.
