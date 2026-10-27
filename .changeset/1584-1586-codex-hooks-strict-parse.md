---
"@donadiosolutions/lcm": patch
---

Make `lcm connectors install codex` stop, leaving `hooks.json` and
`config.toml` untouched, when `hooks.json` is not valid JSON or repeats a key,
instead of replacing it with only the LCM hooks. `lcm doctor` now also reports
a `hooks.json` with a key repeated in the file, a group or a handler, or a
non-integer command or MCP tool `timeout` or command `additionalContextLimit`,
as unreadable.
