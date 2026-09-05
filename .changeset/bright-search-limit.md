---
"@donadiosolutions/lcm": patch
---

Validate `lcm_search` limits at the daemon boundary as positive integers from
1 through 1000, with a default of 5 and a stable HTTP 400 error for invalid
values.
