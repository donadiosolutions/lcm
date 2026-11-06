---
"@donadiosolutions/lcm": patch
---

Reduce PostgreSQL round trips per transaction. Cancellable queries now reuse
one server process ID per transaction, including inside savepoints, instead of
looking it up before every statement. A project-scoped transaction or a
read-only migration snapshot reads that ID in the same exchange that opens it,
and any other transaction reads it no later than its first cancellable query.
Migration steps and daemon requests wait on fewer network round trips, which
matters most when the database is far away.
