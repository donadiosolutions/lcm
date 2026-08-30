---
"@donadiosolutions/lcm": patch
---

Preserve retryable `aborted` errors when a portable source page rejects after
its read signal is cancelled, without advancing the caller's checkpoint.
