---
"@donadiosolutions/lcm": patch
---

Admit PostgreSQL transfer roles provisioned before the `message_parts` column
grants again. Transfer readiness no longer requires the four direct
`message_parts` column `SELECT` grants when the role holds the table-level
`SELECT` that already covers those reads, so such a role stays ready without
re-applying the transcript grants.
