---
"@donadiosolutions/lcm": patch
---

Make stats, status, pool diagnostics, local MCP statistics, and doctor report a shared sanitized snapshot for the selected SQLite or PostgreSQL backend, with bounded collection and explicit readiness/failure states. Omit unavailable metrics and content-bearing previews instead of exposing private data or reporting false zero totals.

Make doctor observational throughout: it no longer starts or restarts the daemon, repairs settings or project maps, prunes orphan sidecars, or spawns an MCP server for a handshake. Use the reported explicit installation, connector, or daemon restart commands for repairs. SQLite diagnostics read committed WAL data without schema migration or durable content changes; necessary WAL/SHM read coordination may still occur.
