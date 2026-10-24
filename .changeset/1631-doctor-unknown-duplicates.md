---
"@donadiosolutions/lcm": patch
---

Stop `lcm doctor` from reporting every Codex hook as `hooks-file-unreadable`
when `hooks.json` repeats a member that Codex ignores, such as an extra note
on a matcher group or a handler. Doctor now rejects a repeated member only when
Codex's own struct for that object knows it (any root member, an event name, a
group's `matcher` or `hooks`, or a field of the handler's `type`), as Codex
does. Install still refuses every repeated key.
