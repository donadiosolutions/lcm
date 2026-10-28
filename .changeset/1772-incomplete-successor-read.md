---
"@donadiosolutions/lcm": patch
---

Migration manifest reads now return the current head when the next revision
directory is empty, so an interrupted update no longer blocks reads, including
migration abort, until it is retried. A next revision that holds a writer
scratch reports `recovery-required` and asks to retry the same create or
update; a manifest or anything that cannot be authenticated still reports
`recovery-required`.
