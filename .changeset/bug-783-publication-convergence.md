---
"@donadiosolutions/lcm": patch
---

Bound `lcm install` and `lcm doctor` publication-lock admission retries to a
single authenticated managed daemon and shared timeout, preserving fail-closed
behavior for foreign or unverifiable owners.
