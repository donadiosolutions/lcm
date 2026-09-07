---
"@donadiosolutions/lcm": patch
---

Read `lcm status` project timestamps through bounded, single-link regular-file
metadata admission, with current-UID ownership checks where numeric UIDs are
available, while preserving null timestamp fallbacks for unavailable metadata.
