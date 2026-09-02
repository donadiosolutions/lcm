---
"@donadiosolutions/lcm": patch
---

Expose `lcm_grep` search modes through MCP. Callers can choose `full_text` or
`regex`; omitting `mode` remains `full_text`, while malformed explicit modes
(including `null`) are rejected instead of silently defaulting to `full_text`.
