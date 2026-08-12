---
"@donadiosolutions/lcm": patch
---

Make daemon startup recovery retire authenticated terminal systemd registrations, including stale failed units, before proving absence and recreating the managed service. This completes the #663/#665 daemon startup-recovery lifecycle hardening.
