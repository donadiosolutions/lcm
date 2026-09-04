---
"@donadiosolutions/lcm": patch
---

Let `lcm doctor` and connector transport resolution converge through a managed
daemon's short backend-publication reconciliation immediately after
`lcm install`. Configuration reads use authenticated, descriptor-bound
lock-free snapshots, and the lock-taking doctor stages (project map, worktree
reconciliation, daemon lifecycle) retry within one shared two-second budget
only while the lock owner is the exact token-authenticated managed daemon.
All configuration and project-map mutations still require the exclusive
publication lock, and any other owner remains fail closed.
