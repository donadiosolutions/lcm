---
"@donadiosolutions/lcm": patch
---

Bound explicit native-transcript backfill and embedded API records after
scrubbing as well as before it. Records whose sanitized canonical UTF-8 form
exceeds 10 MiB are now quarantined locally as `record-too-large` rather than
imported; expansive custom patterns may therefore produce new bounded
quarantine metadata.
