---
"@donadiosolutions/lcm": patch
---

Keep the daemon passive-event processor alive when its diagnostic logger fails
while reporting an error from a background timer. A failing logger no longer
surfaces as an unhandled promise rejection from the interval sweep, scheduled
sweep, replication follow-up, or project debounce timers.
