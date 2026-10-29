---
"@donadiosolutions/lcm": patch
---

A PostgreSQL query that gets no response, for example after a network
partition, used to wait indefinitely. It now fails with a retryable storage
error and its connection is discarded after `statementTimeoutMs` plus a
transport grace of `connectionTimeoutMs` (at least 5 seconds), which is 70
seconds with the defaults. A caller with a shorter deadline still times out
first; lower `statementTimeoutMs` to detect a dead connection sooner.
