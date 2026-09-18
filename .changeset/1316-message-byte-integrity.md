---
"@donadiosolutions/lcm": patch
---

Refuse malformed UTF-8 bytes in legacy SQLite conversation messages during
worktree reconciliation so retries preserve the original source and target
bytes for deliberate offline repair.
