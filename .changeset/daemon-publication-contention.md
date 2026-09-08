---
"@donadiosolutions/lcm": patch
---

Serialize publication admission between operations in the same daemon so
session completion and promotion can wait for in-flight storage work instead
of failing with publication contention. Keep project identity checks fenced,
prevent canceled queued work from opening storage, and retain the native
hook's existing bounded best-effort completion policy.
