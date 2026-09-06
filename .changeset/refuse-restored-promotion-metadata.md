---
"@donadiosolutions/lcm": patch
---

Refuse promotion metadata publication when a restored or concurrent `meta.json`
appears after a missing-file observation, preserving the existing file instead
of replacing it.
