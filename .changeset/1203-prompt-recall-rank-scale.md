---
"@donadiosolutions/lcm": patch
---

Correct prompt recall by scoring native matched-term evidence instead of incomparable backend ranks. Preserve full SQLite Porter matches and default PostgreSQL exact recall, with a four-point bonus only for whole normalized content/query equality and explicit native evidence diagnostics.
