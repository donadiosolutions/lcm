---
"@donadiosolutions/lcm": patch
---

Migration activation now refuses, or reports an interrupted roll-forward on
re-entry, when a destination identity query (S0, S5 or S7) or the S7 census
read fails because the PostgreSQL target is unhealthy or unreachable, instead
of rejecting the whole activation. Unknown errors and cancellations still
reject.
