---
"@donadiosolutions/lcm": patch
---

Validate `lcm_grep` `since` values at the daemon boundary. The inclusive
lower bound now accepts only full timezone-qualified ISO datetimes with an
optional 1-3 digit fractional second and returns a stable `invalid since`
error before project or storage access for malformed values.
