---
"@donadiosolutions/lcm": patch
---

Serialize the PostgreSQL promoted-content deduplication decision so two
concurrent imports or promotions of the same new content can no longer each
observe an empty candidate set and both insert a separate active memory.
