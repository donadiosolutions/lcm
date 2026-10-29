---
"@donadiosolutions/lcm": patch
---

A PostgreSQL query that gets no response, for example after a network
partition, used to wait indefinitely. It now fails with a retryable storage
error and its connection is discarded after `statementTimeoutMs` plus a
transport grace of `connectionTimeoutMs` (at least 5 seconds), which is 70
seconds with the defaults. A caller with a shorter deadline still times out
first; lower `statementTimeoutMs` to detect a dead connection sooner.
The portable transfer destination connection is exempt so large record
uploads on slow links are not cut short; it waits as it did before.
