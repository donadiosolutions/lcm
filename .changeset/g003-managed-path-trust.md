---
"@donadiosolutions/lcm": patch
---

Restrict package-manager bins derived for managed daemon PATHs to recognized
per-user layouts rooted at an authenticated owner home, while preserving
legitimate `~/.local` installs and directly observed executable paths.
