---
"@donadiosolutions/lcm": patch
---

Interpret timezone-less SQLite message timestamps as UTC across message reads
and message search results, preserving millisecond precision and qualified ISO
instants. Newly generated compaction summaries use the corrected message
instants at creation. The separate SQLite metadata backfill issue #1092 can
still rewrite summary bounds when the database is reopened.
