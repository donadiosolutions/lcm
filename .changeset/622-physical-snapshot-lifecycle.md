---
"@donadiosolutions/lcm": patch
---

Keep local hook appends and SQLite physical close operations ordered with
immutable migration capture, and refuse capture when an enrolled canonical
outbox is missing.
