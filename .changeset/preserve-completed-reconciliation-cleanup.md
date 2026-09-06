---
"@donadiosolutions/lcm": patch
---

Preserve a durably completed worktree reconciliation journal when retained
directory cleanup fails after final validation, while still reporting the
cleanup error and allowing later discovery of newly eligible work.
