---
"@donadiosolutions/lcm": patch
---

Honor the documented `LCM_ENABLED=false` setting by making every native Claude and Codex hook a no-op, including the legacy `lcm compact` PreCompact command.
