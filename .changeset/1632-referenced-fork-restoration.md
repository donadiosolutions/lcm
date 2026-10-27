---
"@donadiosolutions/lcm": patch
---

Stop Codex referenced (paginated-history) forks from receiving a second LCM
restoration block. The restore hook now follows the fork's `history_base` to
its parent rollout and checks the inherited history, so a restoration the fork
already carries suppresses the block unless the fork's own records compacted or
rolled it back. A parent that cannot be found or verified still prints a fresh
block.
