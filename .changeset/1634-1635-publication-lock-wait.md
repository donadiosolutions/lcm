---
"@donadiosolutions/lcm": patch
---

Wait briefly for another process's backend-publication lock instead of dropping the work. Restore, compact, Stop, SubagentStop, PreCompact and SubagentStart hooks now wait up to 5 seconds in total, Codex Interrupt and SessionEnd hand-offs wait inside their own time budget, and the daemon waits for the lock before it ingests or restores. A lock held longer than that window still skips the snapshot or restoration as before. Closes #1634 and #1635.
