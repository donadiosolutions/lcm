---
"@donadiosolutions/lcm": patch
---

Preserve project-directory admission and permission failures when closing the
acquired child handle also fails, while still reporting cleanup failures and
closing retained ancestor handles.
