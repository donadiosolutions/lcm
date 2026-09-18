---
"@donadiosolutions/lcm": patch
---

Index owner-scoped exact promoted-content lookup in PostgreSQL with a
generated SHA-256 candidate column and partial btree index, keeping raw
content equality as the residual collision guard. Applying the migration
takes an exclusive schema rewrite and index-build window proportional to
existing promoted-memory data.
