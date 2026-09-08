---
"@donadiosolutions/lcm": patch
---

Redact doubled-colon drive segments inside recognized local paths so malformed
Windows path tails cannot remain visible in sanitized errors.
