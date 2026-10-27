---
"@donadiosolutions/lcm": patch
---

Fix `lcm store`, promotion, passive events and knowledge import merging new
content into an unrelated memory (#1727). The deduplication decision now merges
only text that is exactly the same as an active memory; a BM25 match above
`compaction.promotionThresholds.dedupBm25Threshold` no longer discards the
incoming text. The key is still accepted but no longer merges different text.
Memories damaged by earlier false merges are not repaired.
