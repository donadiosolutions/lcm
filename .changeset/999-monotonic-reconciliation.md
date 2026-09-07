---
"@donadiosolutions/lcm": patch
---

Keep worktree-reconciliation lock retries bounded by monotonic elapsed time so
wall-clock corrections cannot extend, shorten, or otherwise distort contention
waits.
