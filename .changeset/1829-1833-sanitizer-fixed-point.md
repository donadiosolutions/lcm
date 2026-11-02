---
"@donadiosolutions/lcm": patch
---

Make error-message sanitization settle on the first call. A message whose path
redaction needed a second or third sanitization to hide the rest of a path is
now fully redacted the first time, so sanitizing the result again changes
nothing.
