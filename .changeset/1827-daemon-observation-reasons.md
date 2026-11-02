---
"@donadiosolutions/lcm": patch
---

`lcm doctor` and `lcm status` now report why an authenticated daemon observation failed (connection, response or body timeout, HTTP status, invalid response, or identity mismatch) instead of one generic message.
