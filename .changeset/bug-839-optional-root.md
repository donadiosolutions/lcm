---
"@donadiosolutions/lcm": patch
---

Fail closed when a canonical LCM root is interrupted during authentication
after its descriptor is opened, while preserving compatibility for roots that
are absent at the initial read-only probe.
