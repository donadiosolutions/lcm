---
"@donadiosolutions/lcm": patch
---

Retry daemon storage-factory cleanup after a rejected close while preserving
concurrent close coalescing and successful-close idempotence.
