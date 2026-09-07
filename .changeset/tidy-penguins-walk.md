---
"@donadiosolutions/lcm": patch
---

Fix PostgreSQL daemon startup in the installed CLI by resolving SQL assets from their packaged location. Missing or modified migration files continue to fail verification without falling back to source files or SQLite.
