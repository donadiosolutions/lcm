---
"@donadiosolutions/lcm": patch
---

Reject unsafe promote sidecar-root topology instead of creating project
directories through raw recursive `mkdir`. Dry runs remain free of metadata
and project-storage writes.
