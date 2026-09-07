---
"@donadiosolutions/lcm": patch
---

Retain publication admission while SessionStart prunes the local passive-event
outbox, preventing backend publication from racing destructive maintenance.
