---
"@donadiosolutions/lcm": patch
---

Re-running a single rollback that was interrupted while writing its rollback
witness binding now finishes the write and continues instead of refusing the
leftover file as unresolvable on every retry. Only the binding of the
rollback witness already stored for the activation being rolled back, at the
rollback's current manifest revision, is accepted; any other leftover is still
refused and preserved.
