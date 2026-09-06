---
"@donadiosolutions/lcm": patch
---

Redact literal `file://` paths after query and fragment value prefixes so error
messages do not expose local paths embedded in wrapped URL values.
