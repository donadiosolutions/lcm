---
"@donadiosolutions/lcm": patch
---

Reuse retained consumer publication admission while recording missing-working-
directory observations, closing the local outbox, and persisting error-to-fix
correlation. Parking can now reach its third durable observation and correlated
pairs complete local acknowledgement on their first promotion pass without
self-contention.
