---
"@donadiosolutions/lcm": patch
---

Bound native ingest snapshots to 64 MiB and one active request per daemon, and limit ingest session IDs to 1,024 UTF-8 bytes. Oversized snapshots fail without truncation; busy native requests can be retried later. Terminal acceptance covers one attempt and does not automatically retry native contention.
