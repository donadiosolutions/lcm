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
Reconciliation authenticates renewed bindings reached through distinct local
aliases, preserves valid aliases on the successor, and refuses ambiguous or
foreign canonical bindings before source discovery.
After the successor map publication becomes observable, it remains
authoritative through later validation or readback failures so concurrent hook
storage cannot be stranded behind a restored retired binding.
Preserve bounded per-item identity and outcomes throughout compact progress and
summaries, keeping invocation-wide failure totals in the live header, the
failure event, and the final summary instead of repeating them on later
per-item lines.
