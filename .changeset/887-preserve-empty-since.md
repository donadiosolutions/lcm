---
"@donadiosolutions/lcm": patch
---

Preserve explicit empty `grep --since` values so the daemon can reject them
instead of treating them as an omitted filter.
