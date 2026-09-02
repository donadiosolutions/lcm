---
"@donadiosolutions/lcm": patch
---

Retry daemon storage-factory cleanup once in the same terminal pass after a
rejected close while preserving concurrent close coalescing and
successful-close idempotence.
