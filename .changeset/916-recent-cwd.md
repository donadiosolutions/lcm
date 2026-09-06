---
"@donadiosolutions/lcm": patch
---

Repair `memory.recent` to send an absolute project directory as `cwd`, making
the existing `/recent` retrieval path reachable. Calls that supplied a project
hash as `projectId` must migrate to the corresponding directory; hashes are
not interpreted as paths and no ambient working-directory fallback is added.
After project admission, existing HTTP 409 storage identity and HTTP 503
PostgreSQL failures remain observable; invalid limits continue to return 400.
