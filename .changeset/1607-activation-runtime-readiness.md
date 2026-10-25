---
"@donadiosolutions/lcm": minor
---

Require a distinct runtime-role URL for migration activation, verify the
runtime and transfer grant profiles together during activation, and leave
only transfer-grant revocation as the post-activation privilege step.
`activate --set` stays transfer-only and reports its stale-daemon refusal as
`set-restart-required`, whose remedy names the full grant swap.
