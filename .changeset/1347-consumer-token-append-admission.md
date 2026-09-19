---
"@donadiosolutions/lcm": patch
---

Admit local append work that already holds backend publication instead of
queueing it behind an append that cannot proceed, so daemon promote-events
sidecar scans complete rather than timing out under contention.
