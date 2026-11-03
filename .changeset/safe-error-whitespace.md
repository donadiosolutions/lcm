---
"@donadiosolutions/lcm": patch
---

Redact complete unquoted filesystem paths containing spaces or tabs, including
Windows and UNC names. Ambiguous prose after a path is also removed; separate
URLs and quoted or URL-owned path boundaries retain their existing behavior.
