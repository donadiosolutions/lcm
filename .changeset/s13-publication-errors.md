---
"@donadiosolutions/lcm": patch
---

Distinguish backend-publication absence from unresolvable reads. The
PostgreSQL publication witness now returns a discriminated absent, mismatch,
or unresolvable outcome instead of throwing one undifferentiated failure, and
the publication guard reserves invalid-row for genuinely undecodable rows
while a decodable non-matching row reports fence-mismatch. Synchronous-origin
lock tokens are refused at asynchronous coordinator seams.
