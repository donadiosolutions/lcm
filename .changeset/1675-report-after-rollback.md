---
"@donadiosolutions/lcm": patch
---

Route a completed rollback to its settled cell. The router only recognised the
activation publication as the generation's own, so after a successful rollback
`report`, the settled `rollback` re-entry and `activate` were refused with
`route-foreign-publication` (exit 5). The generation's derived rollback
publication is now recognised as its own too.
