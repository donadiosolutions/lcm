---
"@donadiosolutions/lcm": patch
---

Harden describe and expand compatibility handlers by sanitizing fallback error
messages before response serialization, without changing their external HTTP
status or response shape.
