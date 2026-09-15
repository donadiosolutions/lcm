---
"@donadiosolutions/lcm": patch
---

Refuse legacy conversation message content with embedded NUL bytes or a
non-TEXT SQLite type during worktree reconciliation, preserving source and
target data for repair and retry.
