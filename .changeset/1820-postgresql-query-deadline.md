---
"@donadiosolutions/lcm": patch
---

A PostgreSQL query that receives no response, for example after a network
partition, now fails with a retryable storage error and discards its connection
after `statementTimeoutMs` plus a transport grace of at least 5 seconds,
instead of waiting for the caller's own deadline.
