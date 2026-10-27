---
"@donadiosolutions/lcm": minor
---

Add pool, migration, extension, and queue health families to the PostgreSQL
backend diagnostic snapshot shown by `lcm stats`, `lcm status`, and
`lcm doctor`. Each family reports its status, a health of healthy, degraded,
or unavailable, the fields it could not observe, and a fixed next action. A
degraded family raises a healthy snapshot to degraded.
