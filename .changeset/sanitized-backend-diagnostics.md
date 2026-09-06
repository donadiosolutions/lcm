---
"@donadiosolutions/lcm": patch
---

Make stats, status, pool diagnostics, local MCP statistics, and doctor report a shared sanitized snapshot for the selected SQLite or PostgreSQL backend, with bounded collection and explicit readiness/failure states. Omit unavailable metrics and content-bearing previews instead of exposing private data or reporting false zero totals.

Make doctor observational throughout: it no longer starts or restarts the daemon, repairs settings or project maps, prunes orphan sidecars, or spawns an MCP server for a handshake. Use the reported explicit installation, connector, or daemon restart commands for repairs. SQLite diagnostics read committed WAL data without schema migration or durable content changes; necessary WAL/SHM read coordination may still occur.

Show the same complete, safe readiness fields and fixed next actions across diagnostic text output, including failure snapshots. Distinguish aggregate and selected project scope with admitted UUIDs/local hashes, keep unknown selections unavailable, and report absent SQLite machine identity as not applicable without requiring registration.

Reuse one bounded SQLite diagnostic child across projects and sidecars, preserving the whole-snapshot deadline. Keep an authenticated daemon reported as up when its status request fails, and identify the subsequent local diagnostic observation.
