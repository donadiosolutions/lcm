---
"@donadiosolutions/lcm": patch
---

Add an optional absolute `cwd` to `memory.search` so callers can reach the
existing project-scoped `/search` storage path. The daemon remains responsible
for validation; omitted `cwd` keeps the existing empty-result behavior, and
`projectId` is not treated as a project selector.
