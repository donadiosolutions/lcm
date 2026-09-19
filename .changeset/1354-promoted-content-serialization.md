---
"@donadiosolutions/lcm": patch
---

Serialize PostgreSQL promoted-memory deduplication decisions for knowledge
import, so two concurrent imports of the same new content can no longer each
observe an empty candidate set and both insert a separate active memory.
Imports into one project now take turns rather than running side by side;
imports into different projects are unaffected.

Compaction-driven promotion is not covered. It deduplicates through
source-scoped lexical search without the exact-content lookup, so content that
search cannot retrieve can still be stored twice regardless of this
serialization. That gap is tracked in #1390.
