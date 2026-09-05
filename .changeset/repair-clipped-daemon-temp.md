---
"@donadiosolutions/lcm": patch
---

Remove newly created daemon temporary directories whose owner permissions were
clipped by the process umask, and report an actionable retry requirement while
preserving fail-closed validation for existing paths.
