---
"@donadiosolutions/lcm": patch
---

Redact slash-prefixed local paths after word-bearing query or fragment text
following a quoted `file://` path in one sanitization pass, keeping repeated
sanitization byte-stable.
