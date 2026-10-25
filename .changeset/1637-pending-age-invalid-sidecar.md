---
"@donadiosolutions/lcm": patch
---

Omit the local pending age from runtime health telemetry when any local sidecar
reports an invalid oldest pending timestamp, instead of letting a valid sibling
hide it.
