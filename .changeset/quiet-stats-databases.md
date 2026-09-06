---
"@donadiosolutions/lcm": patch
---

Authenticate private project database topology before `lcm stats` opens or
migrates existing SQLite state, and never create a missing project database.
