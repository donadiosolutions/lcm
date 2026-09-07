---
"@donadiosolutions/lcm": patch
---

Preserve write/setup failures when temporary descriptor close also fails in
atomic private-file writers. Retain temporary cleanup errors in ordinary
replacement and non-durable exclusive creation, and ordered descriptor,
temporary-file, and parent cleanup errors in durable writes. Existing
best-effort temporary cleanup in retained-parent exclusive publication and
`writePrivateFileExclusive` remains unchanged.
