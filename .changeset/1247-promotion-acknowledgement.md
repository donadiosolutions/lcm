---
"@donadiosolutions/lcm": patch
---

Fix passive promotion and event draining failing to acknowledge queued events
after committing their memory or migration receipt. Reuse the current
publication token for acknowledgement, retained-token preparation, and owned
storage cleanup while keeping normal preparation outside admission.
