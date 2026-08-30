---
"@donadiosolutions/lcm": patch
---

Cancel pending project opens when requests disconnect or the daemon shuts
down, preventing cancelled reads and restores from returning false success.
Cancelled project opens now use intentional cancellation errors, while
`/promote` retains its existing cancelled-response (499) behavior for
existing-mode cancellation.
