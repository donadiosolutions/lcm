---
"@donadiosolutions/lcm": patch
---

Preserve nested non-file URLs after an unquoted pathless `file://` query or
fragment boundary while continuing to redact standalone and nested filesystem
paths, including query or fragment values quoted around paths containing
spaces.
