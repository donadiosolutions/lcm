---
"@donadiosolutions/lcm": patch
---

Keep Codex PostToolUse capture out of legacy-root bootstrap migration so
concurrent LCM activity cannot fail the observer hook before payload dispatch.
