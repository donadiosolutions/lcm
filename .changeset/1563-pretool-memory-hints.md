---
"@donadiosolutions/lcm": minor
---

Add an opt-in Codex PreToolUse hook that surfaces up to two relevant memories
as advisory context before a shell command, `apply_patch` edit, or MCP tool
call. It is off by default: set `hooks.preToolRecall` to `true` with
`lcm config set hooks.preToolRecall true --json` and reinstall with
`lcm connectors install codex`.
