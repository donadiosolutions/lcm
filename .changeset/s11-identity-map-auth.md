---
"@donadiosolutions/lcm": patch
---

Require local evidence before a project-map key becomes a storage identity,
and stop presenting identities that storage will refuse.

A key is now admitted only when it is the canonical path hash, a renewal
successor whose retained predecessor fence still authenticates it, or a legacy
hash corroborated by its own project metadata. A key meeting none of these is
refused instead of silently becoming the project id for a directory.

Renewal successors are decided by their predecessor fence alone, so the
metadata a renewed project writes when storage first opens it cannot stand in
for a fence that has been lost.

Enumeration follows the same rules. `lcm compact --all`, `lcm import --all`,
and SQLite compaction preview skip an identity they cannot authenticate and
continue with the remaining projects. `lcm project list` marks such an entry
as unauthenticated rather than hiding it, so it stays visible for repair.

