---
"@donadiosolutions/lcm": patch
---

`lcm store` and the `lcm_store` tool now make the same deduplication decision
as knowledge import and `lcm promote`. Storing content that already exists as
an active promoted memory in scope returns that memory's id, with its tags
unioned and its confidence kept at the maximum, instead of creating a second
memory; two identical stores now yield one memory. New content still returns a
fresh id.

On PostgreSQL a manual store also takes the project-scoped deduplication lock,
so it takes turns with a concurrent import or promote into the same project
rather than racing them into a duplicate.
