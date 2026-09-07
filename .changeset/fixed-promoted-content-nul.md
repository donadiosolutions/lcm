---
"@donadiosolutions/lcm": patch
---

Reject embedded NUL characters in new SQLite promoted-memory content before
writing, and fail closed on selected legacy rows instead of returning the
truncated scalar value. Preserve explicit clean replacements and NUL-bearing
JSON tags.
