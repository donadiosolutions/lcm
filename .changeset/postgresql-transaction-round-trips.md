---
"@donadiosolutions/lcm": patch
---

Reduce PostgreSQL round trips per transaction. A project-scoped transaction
now opens and reads its backend identity in one exchange, and cancellable
queries inside a transaction or a migration snapshot reuse that identity
instead of looking it up before every statement. Migration steps and daemon
requests wait on fewer network round trips, which matters most when the
database is far away.
