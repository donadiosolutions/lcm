---
"@donadiosolutions/lcm": patch
---

Fence SQLite factory health during shutdown races so in-flight active and idle
project probes return closed without exposing probe details.
