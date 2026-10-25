---
"@donadiosolutions/lcm": patch
---

Cutover-set activation now allocates census scratch only for a member census,
reports a storage failure of a destination identity query or census read as a
target refusal naming the member, and reports an interrupted run as applied
only when the live configuration and project map agree with the publication
journal or the set's pre-publication source.
