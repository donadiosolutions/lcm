---
"@donadiosolutions/lcm": patch
---

Harden daemon request construction, daemon timer configuration, hook fallback logging, and user-provided regular expression handling to resolve CodeQL security alerts. Hook fallback logs now use the fixed lcm log path instead of honoring `LCM_LOG_PATH`.
