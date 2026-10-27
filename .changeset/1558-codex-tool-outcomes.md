---
"@donadiosolutions/lcm": patch
---

Interpret current Codex tool outcomes correctly. Passive capture now accepts the
`Bash` tool name Codex emits for shell commands, keeps the legacy
`functions.exec` names as aliases, and no longer treats a shell command as
successful just because Codex reported no status: git and install commands with
no structured status are stored as a `tool_outcome_unknown` observation, which
is never promoted, reinforced or correlated as the fix for an earlier error.
Codex MCP calls are recorded as before when the result is a success.
