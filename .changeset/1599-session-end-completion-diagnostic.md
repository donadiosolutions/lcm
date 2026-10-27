---
"@donadiosolutions/lcm": patch
---

Report a fixed stderr line when the daemon does not acknowledge a Claude
SessionEnd completion within its one-second wait, naming a timeout, an HTTP
status, or an unavailable daemon, without changing the hook's exit code or
stdout.
