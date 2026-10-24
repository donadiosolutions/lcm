---
"@donadiosolutions/lcm": patch
---

Let a migration activation or cutover-set retry finish when a crash left the
backend publication journal at `releasing` or `abort-releasing` after the
remote fence was released and another home's publication acquired the released
lease row. The PostgreSQL remote guard now offers a release-reconciliation
read, and the coordinator treats a row of another identity with a strictly
greater fencing token as proof that its own fence was released, without
touching the successor's row. Without that proof, or for a corrupt row, the
retry still fails closed.
