---
"@donadiosolutions/lcm": patch
---

Preserve interrupted legacy-home migration recovery by refusing passive event capture until migration finishes, with explicit retry guidance and no target-backed error log or Codex receipt writes.

Fail capture explicitly when legacy migration evidence is unreadable, malformed, or unsafe. Preserve the evidence and resolve it before retrying; failed capture does not write hook logs or acknowledge the event as durable.
