---
"@donadiosolutions/lcm": patch
---

Pair passive-event scrubber paths with the project identity admitted by the
selected storage backend. Identity drift now blocks promotion with a sanitized
503 response before backend open or event acknowledgement, leaving the batch
pending for a later retry.
