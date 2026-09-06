---
"@donadiosolutions/lcm": patch
---

Reject preliminary project metadata that would exceed 1 MiB after UTF-8
serialization, preserving any existing metadata instead of publishing a file
that the next initialization cannot read.
