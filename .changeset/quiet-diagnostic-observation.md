---
"@donadiosolutions/lcm": patch
---

Preserve existing SQLite sidecars when status, pool statistics, and doctor authenticate an already-running daemon. These diagnostics now observe process identity without invoking active storage readiness. Doctor reports that readiness and passive queue draining remain unverified, separately from its backend read diagnostics.
