---
"@donadiosolutions/lcm": patch
---

Tighten promotion of passive-learning events when a project working directory
has disappeared so the flow no longer creates spurious project-map entries for
never-seen paths, repairs private-directory permissions on existing sidecars,
and fails closed on malformed or inconsistent persisted parking state during
both runtime observation and worktree reconciliation.
