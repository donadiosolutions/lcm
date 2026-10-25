---
"@donadiosolutions/lcm": patch
---

Report the classified failure reason in the `extensions` runtime health
family of the backend diagnostic snapshot. When the PostgreSQL health check
failed without returning extension records, the family kept a generic
`unavailable` status even for a permission or timeout failure; it now reports
`permission-denied` or `timeout` like the other families that were never
observed.
