---
"@donadiosolutions/lcm": patch
---

Stop `lcm doctor` from reporting every Codex hook as `hooks-file-unreadable`
when `hooks.json` gives a `prompt` or `agent` handler a `timeout` or
`statusMessage` that is not valid. Codex ignores both members on those handler
types and loads the file, so doctor no longer checks them there. Command and
`mcp_tool` handlers keep the existing checks.
