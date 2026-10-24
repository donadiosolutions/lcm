---
"@donadiosolutions/lcm": patch
---

Accept a passive event the daemon already drained while PostgreSQL's inbox
still lists it as pending when rolling back to SQLite, and refuse a genuine
divergence before the rollback publishes anything.
