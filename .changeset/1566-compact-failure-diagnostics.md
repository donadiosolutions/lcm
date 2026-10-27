---
"@donadiosolutions/lcm": patch
---

Make `lcm compact` report actionable per-session failures. Failed sessions now
name the cause (lost daemon connection, rejected authentication, unavailable
daemon, daemon error, or unbound project) and the next step instead of a
generic "compaction request failed", without echoing raw daemon or provider
error text.
