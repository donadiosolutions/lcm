---
"@donadiosolutions/lcm": patch
---

Serialize the PostgreSQL promoted-content deduplication decision for knowledge
import, so two concurrent imports of the same new content can no longer each
observe an empty candidate set and both insert a separate active memory.

Compaction-driven promotion is not covered. It deduplicates through
source-scoped lexical search without the exact-content lookup, so content that
search cannot retrieve can still be stored twice regardless of this
serialization. That gap is tracked in #1390.
