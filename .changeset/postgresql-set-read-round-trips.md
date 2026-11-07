---
"@donadiosolutions/lcm": patch
---

Reduce PostgreSQL round trips in migration reads. Runtime readiness checks,
migration verification, and the copy steps that read a project's identity,
occupancy and row counts now combine independent reads into fewer
statements. They run the same checks as before, so migration commands wait on
fewer network round trips, which matters most when the database is far away.
