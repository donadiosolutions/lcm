---
"@donadiosolutions/lcm": patch
---

Interpret timezone-less SQLite message timestamps as UTC across message reads
and message search results, preserving fractional precision and qualified ISO
instants. Newly generated compaction summaries now derive correct UTC bounds;
existing summary bounds are not rewritten.
