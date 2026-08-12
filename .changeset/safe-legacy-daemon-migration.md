---
"@donadiosolutions/lcm": patch
---

Migrate authenticated legacy Linux daemons only after their PID file disappears during exact stop, while refusing every discoverable unit that is not fully authenticated running and PID evidence whose descriptor cannot be closed safely.
