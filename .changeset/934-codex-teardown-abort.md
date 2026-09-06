---
"@donadiosolutions/lcm": patch
---

Reject Codex configuration resolution with `AbortError` when the caller
cancels during owned app-server teardown, after termination settles, instead
of returning the validated endpoint or token-class default.
