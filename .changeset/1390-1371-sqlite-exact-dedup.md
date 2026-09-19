---
"@donadiosolutions/lcm": patch
---

The exact-content dedup lookup added for PostgreSQL now runs on every
backend. `lcm store`, `lcm promote`, and knowledge import previously
merged content with no searchable lexical terms (for example,
punctuation-only text) into an existing active memory only on PostgreSQL;
on SQLite, ranked search returned no candidates for such content and two
identical writes produced two active memories. SQLite's exact-content
lookup is a plain indexed lookup with no lexical dependency and is now
consulted the same way PostgreSQL's already was, within SQLite's existing
source-scoped boundary.
