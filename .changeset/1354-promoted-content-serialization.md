---
"@donadiosolutions/lcm": patch
---

Serialize PostgreSQL promoted-memory deduplication decisions for knowledge
import, so two concurrent imports of the same new content can no longer each
observe an empty candidate set and both insert a separate active memory.
Imports into one project now take turns rather than running side by side;
imports into different projects are unaffected.
