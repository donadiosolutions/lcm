---
"@donadiosolutions/lcm": patch
---

Cancel pending project opens when requests disconnect or the daemon shuts
down, preventing cancelled reads and restores from returning false success.
Create-mode cancellation now uses the intentional AbortError so promotion
follows its existing cancelled-response (499) path.
