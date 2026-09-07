---
"@donadiosolutions/lcm": patch
---

Refuse promotion metadata publication when a restored or concurrent `meta.json`
appears after a missing-file observation, preserving the existing file instead
of replacing it. Report post-link cleanup or single-link verification failures
as critical published outcomes so an ambiguous `meta.json` cannot be hidden by
best-effort metadata handling.
