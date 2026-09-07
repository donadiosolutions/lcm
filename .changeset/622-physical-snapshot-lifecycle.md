---
"@donadiosolutions/lcm": patch
---

Keep local hook appends and SQLite physical close operations ordered with
immutable migration capture, and refuse capture when an enrolled canonical
outbox is missing. Retry the one authenticated lock-owner disappearance race
that can occur while a valid owner releases its lock. Keep SessionStart outbox
pruning inside one composed consumer and append admission. Reuse the live
request token for project close, and publish a registered migration identity
only after its exact receipt epoch is durable.
