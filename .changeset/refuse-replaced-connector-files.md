---
"@donadiosolutions/lcm": patch
---

Prevent connector removal and install rollback from deleting or overwriting a
replacement at an authenticated connector pathname. Linux connector mutations
now retain the original leaf descriptor, neutralize wholly managed files
without unlinking, and report rollback-incomplete residual artifacts when safe
physical deletion is impossible.

Sanitize connector removal and rollback diagnostics so retained descriptor
operation paths and nested low-level error causes are never exposed publicly.
