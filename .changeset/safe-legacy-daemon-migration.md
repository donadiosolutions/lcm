---
"@donadiosolutions/lcm": patch
---

Migrate authenticated legacy Linux daemons only after their PID file disappears during exact stop, bind bounded systemd stop/final polling to the exact authenticated invocation ID until unit absence, and refuse every discoverable unit that is not fully authenticated running or PID evidence whose descriptor cannot be closed safely.
