---
"@donadiosolutions/lcm": patch
---

Fix SQLite health checks incorrectly reporting unavailable after multiple projects are opened in the same home. Factory health probes now run sequentially per home, including overlapping health requests, while preserving maintenance and real contention checks.
