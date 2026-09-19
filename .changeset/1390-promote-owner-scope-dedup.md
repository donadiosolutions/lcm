---
"@donadiosolutions/lcm": patch
---

Compaction-driven promotion on PostgreSQL now deduplicates against the bound
project's whole provenance and consults the exact-content lookup, as knowledge
import and passive promotion already do. A promoted summary whose exact
content is already an active memory merges into it even when ranked search
cannot recall that content, so it is no longer stored twice.
