---
"@donadiosolutions/lcm": patch
---

Retain the authenticated reconciliation journal directory throughout each
locked mutation attempt so normal and blocked-state journal writes detect a
replaced parent and fail closed. Refuse lock-contention retries when that
authenticated directory changed during the attempt.
