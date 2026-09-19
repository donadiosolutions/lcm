---
"@donadiosolutions/lcm": patch
---

Start passive-event replication automatically on PostgreSQL-backed daemons. A
PostgreSQL daemon now uploads local hook events to the remote inbox on its own
passive-event sweep, once at startup and then every five minutes, where before
that only happened when a worker was run explicitly. Because nothing ran it,
local events could never reach the acknowledged and remote-pruned state that
local retention depends on, so a project's event table only grew.

A pass runs for a project only when the backend is PostgreSQL, a machine
identity is registered, the project is linked to a remote project id, and
PostgreSQL reports healthy. Each unmet condition is a quiet skip, and a
SQLite-backed daemon never opens a PostgreSQL connection, so its behaviour is
unchanged.

`lcm status` now reports what replication has done under `passiveEvents`:
whether it is enabled, when the last pass ran, and how many events were
uploaded, applied, acknowledged, pruned, retried and quarantined. A daemon that
has never replicated says so, which distinguishes nothing to do from never ran.
