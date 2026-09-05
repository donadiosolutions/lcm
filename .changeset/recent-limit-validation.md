---
"@donadiosolutions/lcm": patch
---

Validate the daemon `POST /recent` limit as an integer from 1 through 1000,
defaulting omitted limits to 5 and rejecting malformed values before project
or storage admission.
