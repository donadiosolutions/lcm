---
"@donadiosolutions/lcm": patch
---

Refuse `lcm migration apply` for a project that is already linked to a
PostgreSQL project before it creates any local or destination project
identity, so the refusal reports `applied: false` and leaves PostgreSQL
untouched.
