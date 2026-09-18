---
"@donadiosolutions/lcm": minor
---

Add the internal bounded SQLite-to-PostgreSQL migration copy and resume API.
Authenticated snapshots, a project-wide database lease, exact transfer receipts,
and durable local effects keep retries from duplicating data or advancing local
progress ahead of a proven commit. Copy completion preserves SQLite selection
and maintenance; verification and activation remain separate operations.
