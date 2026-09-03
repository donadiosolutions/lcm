---
"@donadiosolutions/lcm": patch
---

Surface typed PostgreSQL surfacing-log failures from `/prompt-search` as
sanitized HTTP 503 responses without falling back to SQLite, while keeping the
prompt hook's optional hint behavior fail-open.
