---
"@donadiosolutions/lcm": patch
---

Refuse non-text or embedded-NUL promoted-memory rows during legacy worktree
reconciliation instead of importing a truncated value, while preserving
in-place repair and retry behavior.
