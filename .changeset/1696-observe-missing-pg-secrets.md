---
"@donadiosolutions/lcm": patch
---

Let the authenticated `GET /health/observe` endpoint answer for a daemon that
started on SQLite when the on-disk selection is PostgreSQL and the daemon's own
environment lacks `LCM_POSTGRES_URL`, `LCM_POSTGRES_CA_FILE`, or the migration
role. `lcm migration report` and an `activate` retry now report exit 8
restart-required instead of exit 5 for that stale daemon; present values are
still validated, and a daemon binary from before this fix still gives exit 5.
