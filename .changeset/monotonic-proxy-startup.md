---
"@donadiosolutions/lcm": patch
---

Keep internal proxy startup health polling on a monotonic elapsed-time
deadline so wall-clock changes cannot extend or shorten the startup budget.
