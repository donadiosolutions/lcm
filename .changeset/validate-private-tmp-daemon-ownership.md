---
"@donadiosolutions/lcm": patch
---

Keep managed daemon validation working inside Linux `PrivateTmp` user
namespaces by matching the loopback listener's kernel cgroup to the exact
systemd service while preserving fail-closed PID, health, and manager identity
checks.
