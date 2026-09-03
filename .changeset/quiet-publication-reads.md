---
"@donadiosolutions/lcm": patch
---

Keep doctor configuration reads and connector transport resolution available
during a managed daemon's short backend-publication reconciliation by using
authenticated, descriptor-bound lock-free snapshots. Configuration mutations
continue to require the exclusive publication lock.
