---
"@donadiosolutions/lcm": patch
---

Diagnose retired local project identity fences in prompt hooks and batch
compaction, and report that diagnosis for every storage backend rather than
only SQLite. Add an idempotent identity-renewal command that resolves the Git
project anchor first, so it can be run from a nested directory or a linked
worktree as its own diagnostic advises. Renewed projects keep working after
renewal: worktree reconciliation treats an authenticated successor as the
target instead of folding it back into the retired hash, and identity evidence
authenticates a successor id against the retained predecessor fence so a
renewed project can still recover its sidecar when the map is unavailable.
Preserve bounded per-item identity and outcomes throughout compact progress and
summaries, keeping invocation-wide failure totals in the live header, the
failure event, and the final summary instead of repeating them on later
per-item lines.
