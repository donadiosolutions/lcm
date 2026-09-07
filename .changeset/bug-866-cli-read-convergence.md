---
"@donadiosolutions/lcm": patch
---

Retry authenticated publication contention for local CLI inspection and
export preparation, while emitting each read result or export exactly once.
Exhausted or rejected export admission now fails the command, including when
an all-project export has already written earlier projects.
