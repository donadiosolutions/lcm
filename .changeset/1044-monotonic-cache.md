---
"@donadiosolutions/lcm": patch
---

Keep the process-local worktree discovery cache on a monotonic elapsed-time
clock so wall-clock corrections cannot extend or shorten its 1,000 millisecond
TTL.
