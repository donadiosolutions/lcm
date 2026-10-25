---
"@donadiosolutions/lcm": patch
---

Migration activation on an uninitialized LCM home now returns the classified
`manifest-absent` refusal instead of throwing, and an unreadable machine
identity or census scratch directory is reported as a `state-unresolvable`
outcome rather than an exception.
