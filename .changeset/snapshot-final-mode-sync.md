---
"@donadiosolutions/lcm": patch
---

Seal private SQLite snapshot artifacts to read-only mode before the final file
sync, so that sync includes the final permission metadata before the committed
snapshot marker is published.
