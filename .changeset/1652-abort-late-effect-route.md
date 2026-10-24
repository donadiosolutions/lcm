---
"@donadiosolutions/lcm": patch
---

Classify a pending migration effect that appears after `lcm migration abort`
has routed again, so the refusal names `resume` only when `resume` may run
it and otherwise reports the router's refusal (such as operator required,
exit 7).
