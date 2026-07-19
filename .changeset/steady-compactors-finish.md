---
"@donadiosolutions/lcm": patch
---

Prevent `lcm compact --all` from repeatedly selecting fresh-tail-only conversations, limit automatic promotion to projects compacted by the current run, and return exit status 1 when that automatic promotion fails.
