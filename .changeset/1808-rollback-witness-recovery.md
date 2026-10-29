---
"@donadiosolutions/lcm": patch
---

Re-running a rollback, single or set, that was interrupted while writing its
rollback witness now finishes the write and continues instead of refusing the
leftover file as unresolvable on every retry. Only the complete rollback
witness of the activation being rolled back, reproducible from its stored
epoch and attempt, is accepted; any other leftover is still refused and
preserved.
