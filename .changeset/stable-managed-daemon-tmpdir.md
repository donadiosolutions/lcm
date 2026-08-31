---
"@donadiosolutions/lcm": patch
---

Managed background daemons now use a stable, private state-root temporary
directory independent of the caller's `TMPDIR`, `TMP`, and `TEMP` values.
