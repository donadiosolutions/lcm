---
"@donadiosolutions/lcm": patch
---

Classify a pending migration effect that appears after `lcm migration abort`'s
first route, so the refusal names `resume` only when `resume` may run it, and
otherwise reports the router's refusal (such as operator required, exit 7) or
`abort-journal-moved` when abort is still admitted.
