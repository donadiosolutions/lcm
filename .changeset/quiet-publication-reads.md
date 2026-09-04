---
"@donadiosolutions/lcm": patch
---

Let `lcm doctor` and connector transport resolution converge through a managed
daemon's short backend-publication reconciliation immediately after
`lcm install`. Configuration reads use authenticated, descriptor-bound
lock-free snapshots while retaining and revalidating the canonical private LCM
root when one is present. Legacy SQLite reads without an admissible root remain
compatible only while publication evidence is absent. The lock-taking doctor
stages (project map, worktree reconciliation, daemon lifecycle) retry within
one shared two-second budget only while the lock owner is the exact
token-authenticated managed daemon. Platform process-birth helpers and health
probes are bounded by that remaining shared budget. All configuration and
project-map mutations still require the exclusive publication lock, and any
other owner remains fail closed.
